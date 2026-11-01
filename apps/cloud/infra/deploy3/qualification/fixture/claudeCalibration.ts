import { readRpcData } from "../../../../src/rpc/Resources.ts";
import type { Computer } from "../../../../src/computer/Computer.ts";
import { createProductComputer } from "../../../../src/computer/ProductComputer.ts";
import { ChildWorkerCapacity } from "../../../../src/computer/ChildWorkerCapacity.ts";
import {
  createFacetSqliteStorage,
  type FacetStorage,
} from "../../../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../../../src/kernel/KernelWakeRegistry.ts";
import { createKernelSessionStdio } from "../../../../src/kernel/KernelSessionStdio.ts";
import { createNodeFs } from "../../../../src/isolate/NodeFs.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../../../../src/harness/NodeNativeModules.ts";
import { inspectNodeHarnessRelease } from "../../../../src/harness/InspectNodeHarnessRelease.ts";
import type { ChildWorkerLoaderPort } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { claudeNodeRuntimeIdentity } from "./claudeSeed.ts";
import { createClaudePreparedImports } from "./claudePreparedModules.ts";
import type { loadClaudeQualificationRuntime } from "./claudeConfiguration.ts";

/** Calibration owns a separate personality and never launches the inspected CLI or a child. */
export async function calibrateClaudePreparedRelease(input: {
  readonly ctx: { readonly storage: FacetStorage };
  readonly capability: Pick<QualifierCapabilities, "catalog" | "inventory" | "read">;
  readonly release: Awaited<ReturnType<typeof loadClaudeQualificationRuntime>>;
  readonly home: string;
}) {
  const catalog = await readRpcData(input.capability.catalog("claude-code"));
  const inventory = await readRpcData(input.capability.inventory("claude-code"));
  const wakes = new KernelWakeRegistry();
  const stdio = createKernelSessionStdio(wakes);
  const storage = createFacetSqliteStorage(input.ctx.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: stdio.stdio,
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  let commands: ReturnType<typeof createProductComputer> | undefined;
  const failures: unknown[] = [];
  let result:
    | Awaited<ReturnType<ReturnType<typeof createClaudePreparedImports>["inspect"]>>
    | undefined;
  try {
    const fs = createNodeFs(files).fs;
    for (const [path, file] of Object.entries(catalog.files)) {
      fs.mkdirSync(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
      fs.writeFileSync(path, await readRpcData(input.capability.read(path)), {
        mode: file.mode,
      });
      fs.chmodSync(path, file.mode);
    }
    for (const directory of [input.home, "/workspace", "/tmp"])
      fs.mkdirSync(directory, { recursive: true });
    files.chdir("/workspace");
    const loader: ChildWorkerLoaderPort = {
      run: async () => {
        throw new Error("Claude import calibration cannot launch a command worker");
      },
    };
    commands = createProductComputer({
      threadId: "claude-import-calibration",
      filesystem: files,
      wakes,
      capacity: new ChildWorkerCapacity(1, {
        owner: "qualifier/claude-import-calibration",
        RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
      }),
      programs: catalog.codes,
      loader,
      machineInventory: inventory,
      machine: () => ({
        files: {
          current: () => ({
            generation: null,
            generationAbsent: true,
            pristine: true,
            imageDigest: inventory.imageDigest,
          }),
          markExecuted: async () => {
            throw new Error("Claude import calibration has no machine");
          },
          lookup: async () => {
            throw new Error("Claude import calibration has no machine files");
          },
        },
        spawn: async () => {
          throw new Error("Claude import calibration cannot launch a machine process");
        },
      }),
      signal: stdio.signal,
    });
    const computer: Computer = {
      threadId: "claude-import-calibration",
      files,
      exec: commands.exec,
      port: async () => {
        throw new Error("Claude import calibration cannot open a port");
      },
      save: async () => {
        throw new Error("Claude import calibration cannot publish files");
      },
    };
    const imports = createClaudePreparedImports();
    let sdk: Awaited<ReturnType<typeof imports.loadSdk>> | undefined;
    let packages: string[] = [];
    result = await inspectNodeHarnessRelease(
      {
        host: commands.host,
        computer,
        stdio,
        loadedRelease: input.release,
        identity: claudeNodeRuntimeIdentity(input.home),
        systemIdentity: commands.systemIdentity,
        env: { HOME: input.home, PATH: "/bin:/usr/bin", TMPDIR: "/tmp", LANG: "C", LC_ALL: "C" },
        nativeModules: DEFAULT_NODE_NATIVE_MODULES,
        loadPackages: async (_bridge, signal) => {
          const loaded = await imports.loadPackages(input.release.plan, signal);
          packages = Object.keys(loaded).sort();
          return loaded;
        },
        loadRelease: async (_bridge, signal) => {
          sdk = await imports.loadSdk(input.release.plan, signal);
          return await imports.loadRelease(input.release.plan, signal);
        },
        bun: {
          main: `/release/${input.release.plan.main.module}`,
          version: input.release.plan.cli.version,
          revision: input.release.artifact.sourceIdentity,
        },
        modelTransport: async () => {
          throw new Error("Claude import calibration cannot call a model");
        },
      },
      async (cli) => ({
        sdk: { version: input.release.plan.sdk.version, exports: Object.keys(sdk ?? {}).sort() },
        cli: {
          version: input.release.plan.cli.version,
          exports: Object.keys(cli).sort(),
          launch: typeof Reflect.get(cli, input.release.plan.main.export) === "function",
        },
        packages,
        nativeStarted: false,
      }),
    );
  } catch (error) {
    failures.push(error);
  }
  const closed = await Promise.allSettled([commands?.close(), stdio.dispose()]);
  for (const entry of closed)
    if (entry.status === "rejected" && !failures.includes(entry.reason))
      failures.push(entry.reason);
  for (const dispose of [() => files.dispose(), () => wakes.dispose()]) {
    try {
      dispose();
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Claude calibration or cleanup failed");
  if (result === undefined) throw new Error("Claude import calibration did not complete");
  return result;
}
