import { createFacetSqliteStorage } from "../FacetSqliteStorage.ts";
import { KernelFileSystem } from "../KernelFileSystem.ts";
import { createKernelAsyncWasi } from "../KernelWasi.ts";
import { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import { sqliteFixture } from "./sqliteFixture.ts";
import { wasmImportReactor } from "./wasmGuest.ts";

export const READ = 2n;
export const WRITE = 64n;
export const STAT = 1n << 21n;
export const PATH_OPEN = 1n << 13n;
export const PATH_STAT = 1n << 18n;
export const PATH = 64;
export const OUTPUT = 256;
export const DATA = 384;
export const IOV = 512;

const params = {
  path_open: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
  path_filestat_get: ["i32", "i32", "i32", "i32", "i32"],
  fd_read: ["i32", "i32", "i32", "i32"],
  fd_write: ["i32", "i32", "i32", "i32"],
  fd_filestat_get: ["i32", "i32"],
  fd_fdstat_get: ["i32", "i32"],
  fd_close: ["i32"],
} as const;

export function wasiDeviceFixture(
  options: {
    readOnly?: boolean;
    deviceMount?: boolean;
    overlay?: boolean;
    mountPath?: string;
  } = {},
) {
  const sql = sqliteFixture();
  const overlaySql = options.overlay ? sqliteFixture() : undefined;
  const now = () => 1_800_000_000_000_000_001n;
  const storage = createFacetSqliteStorage(sql.storage, now);
  const mounts = [
    {
      path: options.mountPath ?? (options.deviceMount ? "/dev" : "/"),
      storage,
      readOnly: options.readOnly ?? false,
    },
  ];
  if (overlaySql !== undefined)
    mounts.push({
      path: "/dev",
      storage: createFacetSqliteStorage(overlaySql.storage, now),
      readOnly: false,
    });
  const filesystem = new KernelFileSystem({ mounts });
  const wakes = new KernelWakeRegistry();
  const bindings: ReturnType<typeof createKernelAsyncWasi>[] = [];

  return {
    filesystem,
    storage,
    async syscall(name: keyof typeof params, agentOsPreopens = false) {
      const binding = createKernelAsyncWasi({ filesystem, wakes, agentOsPreopens });
      bindings.push(binding);
      const instance = new WebAssembly.Instance(
        wasmImportReactor("wasi_snapshot_preview1", name, params[name], ["i32"]),
        binding.wasi.getImportObject(),
      );
      await binding.wasi.initialize(instance);
      const { memory, run } = instance.exports;
      if (!(memory instanceof WebAssembly.Memory) || !isGuestFunction(run))
        throw new Error("Invalid syscall guest exports");
      return {
        memory,
        view: () => new DataView(memory.buffer),
        run: (...args: Array<number | bigint>) => binding.wasi.run(run, ...args),
        path(value: string | Uint8Array) {
          const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
          new Uint8Array(memory.buffer, PATH, bytes.byteLength).set(bytes);
          return bytes.byteLength;
        },
        iovec(bytes: Uint8Array) {
          new Uint8Array(memory.buffer, DATA, bytes.byteLength).set(bytes);
          const view = new DataView(memory.buffer);
          view.setUint32(IOV, DATA, true);
          view.setUint32(IOV + 4, bytes.byteLength, true);
        },
      };
    },
    async close() {
      try {
        await Promise.all(bindings.map((binding) => binding.wasi.close()));
      } finally {
        filesystem.dispose();
        wakes.dispose();
        sql.close();
        overlaySql?.close();
      }
    },
  };
}

export type DeviceFixture = ReturnType<typeof wasiDeviceFixture>;
export type DeviceSyscall = Awaited<ReturnType<DeviceFixture["syscall"]>>;

function isGuestFunction(
  value: WebAssembly.ExportValue | undefined,
): value is (...args: Array<number | bigint>) => unknown {
  return typeof value === "function";
}

export function openDevice(
  call: DeviceSyscall,
  path: string | Uint8Array,
  rights = READ | WRITE | STAT,
  options: {
    fd?: number;
    dirflags?: number;
    oflags?: number;
    fdflags?: number;
    inheriting?: bigint;
    output?: number;
  } = {},
) {
  return call.run(
    options.fd ?? 3,
    options.dirflags ?? 0,
    PATH,
    call.path(path),
    options.oflags ?? 0,
    rights,
    options.inheriting ?? 0n,
    options.fdflags ?? 0,
    options.output ?? OUTPUT,
  );
}
