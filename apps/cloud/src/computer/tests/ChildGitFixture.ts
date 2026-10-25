import type { KernelAsyncProgramContext } from "../../kernel/KernelAsyncProgram.ts";
import { kernelError, kernelOk } from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import {
  KernelFileSystem,
  KernelOpenFlags,
  type KernelPosixOptions,
  type WasiStdio,
} from "../../kernel/KernelFileSystem.ts";
import { createKernelGitHost } from "../../kernel/KernelGitHost.ts";
import {
  KernelProcessTable,
  type KernelExitStatus,
  type KernelProcessIdentity,
} from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import type { AgentOsSpawnRequest } from "../../kernel/AgentOsProcessWire.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";

export const gitCredentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 } as const;
export const text = (value: string) => new TextEncoder().encode(value);
export const exited = (exitCode = 0): KernelExitStatus => ({
  exitCode,
  signal: 0,
  coreDumped: false,
});

export interface ChildGitFixtureOptions {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly posix?: KernelPosixOptions | false;
  readonly spawn?: KernelAsyncProgramContext["spawn"];
  readonly stdoutWrite?: WasiStdio["write"];
}

/** A real isolated process and filesystem fixture for child Git and host lifetime tests. */
export function childGitFixture(options: ChildGitFixtureOptions = {}) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const posix =
    options.posix === false
      ? undefined
      : (options.posix ?? { credentials: gitCredentials, umask: 0o022 });
  storage.posix.initialize(storage.root, {
    uid: posix?.credentials.uid ?? 1000,
    gid: posix?.credentials.gid ?? 1000,
    mode: 0o755,
  });
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    ...(posix === undefined ? {} : { posix }),
    stdio: [
      { readInto: () => 0 },
      {
        write: (bytes) => {
          if (options.stdoutWrite !== undefined) return options.stdoutWrite(bytes, 0);
          output.push(bytes.slice());
          return bytes.length;
        },
      },
      {
        write: (bytes) => {
          errors.push(bytes.slice());
          return bytes.length;
        },
      },
    ],
  });
  filesystem.mkdir("/workspace");
  filesystem.mkdir("/bin");
  filesystem.mkdir("/etc");
  filesystem.chdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const controller = new AbortController();
  const rootExit = Promise.withResolvers<KernelExitStatus>();
  let identity: KernelProcessIdentity | undefined;
  const admitted = processes.spawn(
    undefined,
    (value) => {
      identity = value;
      return {
        completion: rootExit.promise,
        signal: () => {
          controller.abort();
          return kernelOk(undefined);
        },
      };
    },
    () => {},
  );
  if (admitted.status !== "ok" || identity === undefined)
    throw new Error("Git root admission failed");

  const context: KernelAsyncProgramContext = {
    filesystem,
    home: "/workspace",
    args: options.args ?? ["git", "init", "--quiet"],
    env: options.env ?? {
      HOME: "/workspace",
      PATH: "/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    identity,
    signal: controller.signal,
    processes,
    wakes,
    spawn: (request: AgentOsSpawnRequest) =>
      options.spawn?.(request) ??
      Promise.resolve(kernelError("UNSUPPORTED", "Git child spawn is disabled")),
    exec: async () => {
      throw new Error("Git does not replace its process in this fixture");
    },
  };
  const owner = createKernelGitHost({ context });

  return {
    context,
    filesystem,
    processes,
    wakes,
    controller,
    owner,
    stdout: () => concat(output),
    stderr: () => new TextDecoder().decode(concat(errors)),
    write(path: string, value: string, mode = 0o644) {
      const fd = filesystem.open(
        path,
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        mode,
      );
      try {
        filesystem.write(fd, text(value), null);
      } finally {
        filesystem.close(fd);
      }
    },
    read(path: string) {
      const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
      try {
        const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
        const count = filesystem.read(fd, bytes, null);
        return bytes.slice(0, count);
      } finally {
        filesystem.close(fd);
      }
    },
    async close() {
      try {
        await owner.close();
      } finally {
        rootExit.resolve(exited());
        await processes.dispose();
        wakes.dispose();
        filesystem.dispose();
        database.close();
      }
    },
  };
}

function concat(chunks: readonly Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
