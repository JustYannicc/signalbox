import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelWakeRegistry.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createHarnessSessionHost, type HarnessHostOptions } from "../../HarnessSessionHost.ts";
import {
  createProductHarnessSessionHost,
  type ProductHarnessHostOptions,
} from "../../ProductHarnessSessionHost.ts";
import { claudeFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { commandLoader, programFixture } from "./commands.ts";
import { services } from "./adapter.ts";

type HostKind = "direct" | "product";

async function runtimePorts(): Promise<
  Pick<ProductHarnessHostOptions<unknown>, "commands" | "save" | "port" | "native">
> {
  const deps = await Effect.runPromise(services);
  return {
    commands: {
      loader: commandLoader().loader,
      capacity: new ChildWorkerCapacity(2),
      machine: {
        spawn: async () => {
          throw new Error("Unused machine");
        },
      },
    },
    save: async () => {
      throw new Error("Unused save");
    },
    port: async () => {
      throw new Error("Unused port");
    },
    native: {
      mcpSessions: deps.mcpSessions,
      adapter: () => Effect.die("Unused adapter"),
      loadSdk: async () => {
        throw new Error("Unused SDK");
      },
      process: {
        identity: {
          version: "v24.21.0",
          versions: { node: "24.21.0", bun: "1.3.11" },
          platform: "linux",
          arch: "x64",
          type: "Linux",
          endianness: "LE",
          availableParallelism: 1,
          user: { username: "recorded", uid: 1000, gid: 1000, shell: "/bin/bash" },
          homedir: "/home/recorded",
          tmpdir: "/tmp",
          pid: 1,
          ppid: 0,
          execPath: "/runtime/claude",
          argv0: "claude",
          argv: ["claude"],
        },
        env: {},
        nativeModules: {},
        loadPackages: async () => ({}),
        loadRelease: async () => {
          throw new Error("Unused release import");
        },
        bun: { main: "/release/cli", version: "1.3.11", revision: "controlled" },
      },
    },
  };
}

const nowNs = () => 0n;
const response = async () => new Response();
const unusedBinding = () => Effect.die("Unused runtime binding");

function directOptions(options: ProductHarnessHostOptions<unknown>): HarnessHostOptions<unknown> {
  return {
    ...options,
    files: { ...options.files, wakes: new KernelWakeRegistry() },
    programs: options.programs.seed,
    bindComputer: unusedBinding,
    buildRuntime: unusedBinding,
  };
}

async function makeHost(
  kind: HostKind,
  scope: Scope.Scope,
  database: ReturnType<typeof hostSqlite>,
) {
  const release = await claudeFixture();
  const programs = await programFixture();
  const options: ProductHarnessHostOptions<unknown> = {
    ...(await runtimePorts()),
    threadId: "retention-test",
    release: release.options,
    programs,
    files: {
      identity: "retention-test",
      database: database.open().storage,
      nowNs,
      persistencePorts: createMemoryFilePersistencePorts(),
      rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
      cwd: "/workspace",
      assetMode: 0o644,
    },
    modelTransport: response,
    executor: { forward: response },
  };
  const direct = kind === "product" ? undefined : directOptions(options);
  const refs = {
    options: new WeakRef(direct ?? options),
    source: new WeakRef(options.release.source),
    moduleBuffer: new WeakRef(release.files.get("cli/main/cli.js")!.buffer),
    programs: new WeakRef(direct?.programs ?? programs),
    programReader: new WeakRef(programs.seed.read),
  };
  const creation =
    direct === undefined
      ? createProductHarnessSessionHost(options)
      : createHarnessSessionHost(direct);
  const host = await Effect.runPromise(creation.pipe(Scope.provide(scope)));
  return { host, refs };
}

async function collect() {
  // WeakRef targets survive the current job; full collections need intervening jobs.
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc!();
  }
}

export async function runRetentionProbe() {
  NodeAssert.equal(typeof globalThis.gc, "function", "Run the retention fixture with --expose-gc");
  const results = [];
  for (const kind of ["direct", "product"] as const) {
    const database = hostSqlite();
    const scope = Scope.makeUnsafe();
    try {
      const { host, refs } = await makeHost(kind, scope, database);
      for (const stage of ["assets", "programs"] as const) {
        await Effect.runPromise(host.seed(stage));
        await collect();
        results.push({
          kind,
          stage,
          collected: Object.fromEntries(
            Object.entries(refs).map(([key, ref]) => [key, ref.deref() === undefined]),
          ),
        });
      }
      await Effect.runPromise(host.dispose);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      database.dispose();
    }
  }
  return results;
}
