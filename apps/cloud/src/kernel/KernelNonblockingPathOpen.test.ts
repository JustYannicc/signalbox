import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { RIGHTS } from "./wasi/internal_wasi_descriptors.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const NONBLOCK = 4;
const rootFd = 3;
const pathPointer = 64;
const openedFdPointer = 256;
const pathOpenParams = ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"] as const;

describe("WASI nonblocking path opens", () => {
  it("accepts NONBLOCK for files and directories as a no-op I/O flag", async () => {
    const fixture = sqliteFixture();
    const filesystem = new KernelFileSystem({
      mounts: [
        {
          path: "/",
          storage: createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n),
        },
      ],
    });
    const wakes = new KernelWakeRegistry();
    const runners: WasiImportRunner[] = [];

    try {
      filesystem.mkdir("/work");
      const file = filesystem.open(
        "/work/input.txt",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY,
      );
      filesystem.write(file, new TextEncoder().encode("file data"), 0n);
      filesystem.close(file);
      filesystem.mkdir("/work/directory");

      const pathOpen = await wasiRunner(filesystem, wakes, "path_open", pathOpenParams);
      runners.push(pathOpen);
      const fdstat = await wasiRunner(filesystem, wakes, "fd_fdstat_get", ["i32", "i32"]);
      runners.push(fdstat);
      const read = await wasiRunner(filesystem, wakes, "fd_read", ["i32", "i32", "i32", "i32"]);
      runners.push(read);
      const setFlags = await wasiRunner(filesystem, wakes, "fd_fdstat_set_flags", ["i32", "i32"]);
      runners.push(setFlags);

      const fileFd = await open(pathOpen, "work/input.txt", 0, NONBLOCK, RIGHTS.FD_READ);
      expect(await getFlags(fdstat, fileFd)).toBe(NONBLOCK);
      const readView = new DataView(read.memory.buffer);
      readView.setUint32(64, 128, true);
      readView.setUint32(68, 16, true);
      expect(await read.run(fileFd, 64, 1, 80)).toBe(0);
      expect(new DataView(read.memory.buffer).getUint32(80, true)).toBe(9);
      expect(new TextDecoder().decode(new Uint8Array(read.memory.buffer, 128, 9))).toBe(
        "file data",
      );

      const directoryFd = await open(pathOpen, "work/directory", 2, NONBLOCK, 0n);
      expect(await getFlags(fdstat, directoryFd)).toBe(NONBLOCK);

      const ordinaryFd = await open(
        pathOpen,
        "work/input.txt",
        0,
        0,
        RIGHTS.FD_READ | RIGHTS.FD_FDSTAT_SET_FLAGS,
      );
      expect(await setFlags.run(ordinaryFd, NONBLOCK)).toBe(58);
      expect(await getFlags(fdstat, ordinaryFd)).toBe(0);

      expect(await openErrno(pathOpen, "work/input.txt", 0, 32)).toBe(28);
    } finally {
      await Promise.allSettled(runners.map((runner) => runner.close()));
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
    }
  });
});

interface WasiImportRunner {
  readonly memory: WebAssembly.Memory;
  run(...args: Array<number | bigint>): Promise<number>;
  close(): Promise<void>;
}

async function wasiRunner(
  filesystem: KernelFileSystem,
  wakes: KernelWakeRegistry,
  importName: string,
  params: readonly ("i32" | "i64")[],
): Promise<WasiImportRunner> {
  const wasi = createKernelAsyncWasi({ filesystem, wakes });
  const instance = new WebAssembly.Instance(
    wasmImportReactor("wasi_snapshot_preview1", importName, params, ["i32"]),
    wasi.wasi.getImportObject(),
  );
  await wasi.wasi.initialize(instance);
  const run = instance.exports.run as (...args: Array<number | bigint>) => unknown;
  const memory = instance.exports.memory as WebAssembly.Memory;
  return {
    memory,
    run: (...args) => wasi.wasi.run(run, ...args) as Promise<number>,
    close: () => wasi.wasi.close(),
  };
}

async function open(
  runner: WasiImportRunner,
  path: string,
  oflags: number,
  fdflags: number,
  rightsBase: bigint,
): Promise<number> {
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(runner.memory.buffer, pathPointer, bytes.byteLength).set(bytes);
  expect(
    await runner.run(
      rootFd,
      0,
      pathPointer,
      bytes.byteLength,
      oflags,
      rightsBase,
      0n,
      fdflags,
      openedFdPointer,
    ),
  ).toBe(0);
  return new DataView(runner.memory.buffer).getUint32(openedFdPointer, true);
}

async function openErrno(
  runner: WasiImportRunner,
  path: string,
  oflags: number,
  fdflags: number,
): Promise<number> {
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(runner.memory.buffer, pathPointer, bytes.byteLength).set(bytes);
  return runner.run(
    rootFd,
    0,
    pathPointer,
    bytes.byteLength,
    oflags,
    0n,
    0n,
    fdflags,
    openedFdPointer,
  );
}

async function getFlags(runner: WasiImportRunner, fd: number): Promise<number> {
  return runner.run(fd, 64).then((errno) => {
    expect(errno).toBe(0);
    return new DataView(runner.memory.buffer).getUint16(66, true);
  });
}
