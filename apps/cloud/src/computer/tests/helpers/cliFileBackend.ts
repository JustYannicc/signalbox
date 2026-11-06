import { createCliFileBackend } from "../../../harness/ClaudeCliFileSystem.ts";
import { ClaudeCliKernelOwner } from "../../../harness/ClaudeCliKernelOwner.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import { KernelProcessTable } from "../../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../../kernel/KernelWakeRegistry.ts";
import { createKernelSessionStdio } from "../../../kernel/KernelSessionStdio.ts";
import { createTestFilesystem } from "./filesystem.ts";
import type { KernelSyscallResponse } from "../../../kernel/KernelSyscallPort.ts";
import type { KernelSyscallRequest } from "../../../kernel/KernelSyscallPort.ts";

export async function cliFileBackendFixture(
  byteLimit = 128,
  paths = ["/sync"],
  posix = false,
  options: {
    readonly metadataLimit?: number;
    readonly syscall?: (
      request: KernelSyscallRequest,
      invoke: () => Promise<KernelSyscallResponse>,
    ) => Promise<KernelSyscallResponse>;
    readonly seed?: (
      fs: ReturnType<typeof createNodeFs>["fs"],
      files: import("../../../kernel/KernelFileSystem.ts").KernelFileSystem,
    ) => void;
    /** Runs inside each view refresh, after it starts reading Computer metadata. */
    readonly duringRefresh?: () => void;
  } = {},
) {
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const lifetime = new AbortController();
  const stdio = createKernelSessionStdio(wakes, lifetime.signal);
  const owned = createTestFilesystem(
    stdio.stdio,
    posix
      ? {
          credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
          umask: 0o022,
        }
      : undefined,
  );
  const canonical = createNodeFs(owned.filesystem).fs;
  canonical.writeFileSync("/sync", "before");
  canonical.writeFileSync("/async", "remote");
  options.seed?.(canonical, owned.filesystem);
  const owner = new ClaudeCliKernelOwner(
    {
      storage: { files: owned.filesystem },
      processes,
      stdio,
      commands: () => {
        throw new Error("Filesystem test cannot execute a process");
      },
      compatibilityRevision: () => owned.persistenceRevision(),
    },
    {
      process: {
        identity: {
          version: "v24.21.0",
          versions: { node: "24.21.0" },
          platform: "linux",
          arch: "x64",
          homedir: "/",
          tmpdir: "/",
          pid: 1,
          ppid: 0,
          execPath: "/cli",
          argv0: "cli",
          argv: ["cli"],
        },
        env: {},
        bun: { main: "/cli", version: "1.3.11", revision: "test" },
      },
    },
    lifetime.signal,
    128,
  );
  const requests: KernelSyscallRequest[] = [];
  let failWrites = false;
  let prefetchGate:
    | {
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  let privateLease: number | undefined;
  let refreshes = 0;
  const kernel = new Proxy(owner, {
    get(target, property) {
      if (property === "metadata")
        return async (...args: Parameters<ClaudeCliKernelOwner["metadata"]>) => {
          const page = await target.metadata(...args);
          if (args[0] === 0) {
            refreshes++;
            options.duringRefresh?.();
          }
          return page;
        };
      if (property === "leaseDescriptors")
        return async (count: number) => {
          const ids = await target.leaseDescriptors(count);
          privateLease ??= ids[0];
          return ids;
        };
      if (property === "prefetch")
        return async (...args: Parameters<ClaudeCliKernelOwner["prefetch"]>) => {
          const bytes = await target.prefetch(...args);
          const gate = prefetchGate;
          if (gate !== undefined) {
            prefetchGate = undefined;
            gate.entered.resolve();
            await gate.release.promise;
          }
          return bytes;
        };
      if (property === "call")
        return (request: KernelSyscallRequest) => {
          requests.push(request);
          if (failWrites && request.name === "fd_write")
            return Promise.resolve({ kind: "return" as const, value: 29, regions: [] });
          return options.syscall === undefined
            ? target.call(request)
            : options.syscall(request, () => target.call(request));
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const files = await createCliFileBackend(
    {
      kernel,
      cwd: "/",
      rootDescriptor: owner.rootDescriptor,
      posix: owned.filesystem.posixPolicy,
      workingSet: {
        byteLimit,
        metadataLimit: options.metadataLimit ?? 128,
        pathByteLimit: 256,
        paths,
      },
    },
    lifetime.signal,
  ).catch(async (cause) => {
    await owner.dispose();
    await processes.dispose();
    await stdio.dispose();
    wakes.dispose();
    owned.close();
    throw cause;
  });
  return {
    files,
    fs: createNodeFs(files.backend).fs,
    canonical,
    rootDescriptor: owner.rootDescriptor,
    get privateLease() {
      return privateLease!;
    },
    get refreshes() {
      return refreshes;
    },
    requests,
    holdNextPrefetch() {
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      prefetchGate = gate;
      return { entered: gate.entered.promise, release: () => gate.release.resolve() };
    },
    failWrites() {
      failWrites = true;
    },
    async close() {
      try {
        await files.close();
      } finally {
        await owner.dispose();
        await processes.dispose();
        await stdio.dispose();
        wakes.dispose();
        owned.close();
      }
    },
  };
}
