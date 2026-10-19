import { kernelError } from "../../kernel/KernelAbi.ts";
import {
  KernelProcessTable,
  type KernelProcessIdentity,
  type KernelExitStatus,
} from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import {
  KernelProgramExecAdmissionError,
  type KernelAsyncProgramExecRequest,
} from "../../kernel/KernelAsyncProgram.ts";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import { sqliteFixture } from "../../kernel/tests/sqliteFixture.ts";

export const bashCredentials = {
  uid: 1000,
  gid: 1000,
  euid: 1000,
  egid: 1000,
  umask: 0o022,
  hostname: "child-bash-test",
};
export const text = (value: string) => new TextEncoder().encode(value);
export const exited = (exitCode = 0): KernelExitStatus => ({
  exitCode,
  signal: 0,
  coreDumped: false,
});

export function childBashFixture(
  options: {
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly exec?: (request: KernelAsyncProgramExecRequest) => Promise<KernelExitStatus>;
    readonly maxProcesses?: number;
  } = {},
) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid: 1000, gid: 1000, mode: 0o755 });
  const output: Uint8Array[] = [];
  const errors: Uint8Array[] = [];
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    stdio: [
      { readInto: () => 0 },
      {
        write: (bytes) => {
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
    posix: { credentials: bashCredentials, umask: 0o022 },
  });
  filesystem.mkdir("/workspace");
  filesystem.mkdir("/workspace/nested");
  filesystem.mkdir("/bin");
  filesystem.chdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({
    wakes,
    ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
  });
  const controller = new AbortController();
  const root = Promise.withResolvers<KernelExitStatus>();
  let identity: KernelProcessIdentity | undefined;
  const admitted = processes.spawn(
    undefined,
    (value) => {
      identity = value;
      return {
        completion: root.promise,
        signal: () => {
          controller.abort();
          return { status: "ok", value: undefined };
        },
      };
    },
    () => {},
  );
  if (admitted.status !== "ok" || identity === undefined) throw new Error("Root admission failed");
  const context = {
    filesystem,
    identity,
    processes,
    wakes,
    signal: controller.signal,
    home: "/workspace",
    args: options.args ?? ["caller-bash", "--noprofile", "--norc", "-c", "true"],
    env: options.env ?? { HOME: "/workspace", PATH: "/bin", TOKEN: "雪" },
    exec:
      options.exec ??
      (async () => {
        throw new KernelProgramExecAdmissionError("ENOENT", "No replacement");
      }),
    spawn: async () => kernelError("UNSUPPORTED", "Use the Bash fork port"),
  };
  const owner = createKernelBashHost({ context, credentials: bashCredentials });
  return {
    filesystem,
    context,
    owner,
    processes,
    controller,
    wakes,
    stdout: () => new TextDecoder().decode(concat(output)),
    stderr: () => new TextDecoder().decode(concat(errors)),
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
        const count = filesystem.read(fd, bytes, null);
        return new TextDecoder().decode(bytes.subarray(0, count));
      } finally {
        filesystem.close(fd);
      }
    },
    async close() {
      await owner.close();
      root.resolve(exited());
      await processes.dispose();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}

function concat(chunks: readonly Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
