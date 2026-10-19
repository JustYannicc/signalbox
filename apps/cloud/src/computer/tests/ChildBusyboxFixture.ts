import { kernelError } from "../../kernel/KernelAbi.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import {
  KernelFileSystem,
  KernelOpenFlags,
  type KernelPosixOptions,
  type WasiStdio,
} from "../../kernel/KernelFileSystem.ts";
import {
  KernelProcessTable,
  type KernelExitStatus,
  type KernelProcessIdentity,
} from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { sqliteFixture } from "./helpers/sqliteFixture.ts";

export const busyboxCredentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 };
export const text = (value: string) => new TextEncoder().encode(value);
export const exited = (exitCode = 0): KernelExitStatus => ({
  exitCode,
  signal: 0,
  coreDumped: false,
});

export function childBusyboxFixture(
  options: {
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: Uint8Array;
    readonly readInto?: WasiStdio["readInto"];
    readonly posix?: KernelPosixOptions | false;
  } = {},
) {
  const database = sqliteFixture();
  const root = createFacetSqliteStorage(database.storage, () => 1n);
  const posix =
    options.posix === false
      ? undefined
      : (options.posix ?? { credentials: busyboxCredentials, umask: 0o022 });
  root.posix.initialize(root.root, {
    uid: posix?.credentials.uid ?? 1000,
    gid: posix?.credentials.gid ?? 1000,
    mode: 0o755,
  });
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let offset = 0;
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: root }],
    ...(posix === undefined ? {} : { posix }),
    stdio: [
      {
        readInto:
          options.readInto ??
          ((target) => {
            const bytes =
              options.stdin?.subarray(offset, offset + target.length) ?? new Uint8Array();
            target.set(bytes);
            offset += bytes.length;
            return bytes.length;
          }),
      },
      {
        write: (bytes) => {
          stdout.push(bytes.slice());
          return bytes.length;
        },
      },
      {
        write: (bytes) => {
          stderr.push(bytes.slice());
          return bytes.length;
        },
      },
    ],
  });
  filesystem.mkdir("/workspace");
  filesystem.mkdir("/workspace/nested");
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
          return { status: "ok", value: undefined };
        },
      };
    },
    () => {},
  );
  if (admitted.status !== "ok" || identity === undefined)
    throw new Error("Root process admission failed");
  return {
    filesystem,
    controller,
    context: {
      filesystem,
      identity,
      processes,
      wakes,
      signal: controller.signal,
      home: undefined,
      args: options.args ?? ["/bin/cat"],
      env: options.env ?? { EXACT: "snow雪", EMPTY: "" },
      spawn: async () => kernelError("UNSUPPORTED", "BusyBox does not spawn"),
      exec: async () => {
        throw new Error("BusyBox does not replace its process");
      },
    },
    stdout: () => concat(stdout),
    stderr: () => new TextDecoder().decode(concat(stderr)),
    write(path: string, value: string, mode = 0o644) {
      const fd = filesystem.open(
        path,
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        mode,
      );
      filesystem.write(fd, text(value), null);
      filesystem.close(fd);
    },
    read(path: string) {
      const fd = filesystem.open(path, KernelOpenFlags.O_RDONLY);
      try {
        const bytes = new Uint8Array(Number(filesystem.fstat(fd).size));
        return new TextDecoder().decode(bytes.subarray(0, filesystem.read(fd, bytes, null)));
      } finally {
        filesystem.close(fd);
      }
    },
    async close() {
      rootExit.resolve(exited());
      await processes.dispose();
      wakes.dispose();
      filesystem.dispose();
      database.close();
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
