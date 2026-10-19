import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const now = () => 1_800_000_000_000_000_001n;
const READ = 1n << 1n;
const TRUNCATE = 8;
const ROOT_FD = 3;
const OVERLAY_FD = 4;
const PATH = 64;
const IOV = 128;
const DATA = 160;
const OPENED_FD = 256;
const READ_BYTES = 320;
const OPEN_PARAMS = ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"] as const;

describe("Kernel WASI mount overlays", () => {
  it("blocks hidden inodes across symlink and parent traversal while preserving both visible roots", async () => {
    const rootFixture = sqliteFixture();
    const overlayFixture = sqliteFixture();
    const rootStorage = createFacetSqliteStorage(rootFixture.storage, now);
    const overlayStorage = createFacetSqliteStorage(overlayFixture.storage, now);
    const hiddenDirectory = makeDirectory(rootStorage, rootStorage.root, "m");
    const outside = makeDirectory(rootStorage, rootStorage.root, "outside");
    makeSymlink(rootStorage, rootStorage.root, "shortcut", "/m/jump");
    makeSymlink(rootStorage, hiddenDirectory, "jump", "/outside");
    const hiddenTarget = makeFile(rootStorage, outside, "target", "root target");
    const visibleTarget = makeFile(overlayStorage, overlayStorage.root, "target", "overlay target");
    const filesystem = new KernelFileSystem({
      mounts: [
        { path: "/", storage: rootStorage },
        { path: "/m", storage: overlayStorage },
      ],
    });
    const wakes = new KernelWakeRegistry();
    const runners: WasiImportRunner[] = [];

    try {
      const pathOpen = await wasiRunner(filesystem, wakes, "path_open", OPEN_PARAMS);
      runners.push(pathOpen);
      const fdRead = await wasiRunner(filesystem, wakes, "fd_read", ["i32", "i32", "i32", "i32"]);
      runners.push(fdRead);

      const overlayFd = await open(pathOpen, OVERLAY_FD, "target", READ);
      expect(await readText(fdRead, overlayFd)).toBe("overlay target");

      const rootFd = await open(pathOpen, ROOT_FD, "outside/target", READ);
      expect(await readText(fdRead, rootFd)).toBe("root target");

      const absoluteSymlinkErrno = await openErrno(pathOpen, ROOT_FD, "shortcut/target", TRUNCATE);
      const parentTraversalErrno = await openErrno(
        pathOpen,
        ROOT_FD,
        "m/../outside/target",
        TRUNCATE,
      );
      const hiddenTargetSize = rootStorage.stat(hiddenTarget).size;
      expect({ absoluteSymlinkErrno, parentTraversalErrno, hiddenTargetSize }).toEqual({
        absoluteSymlinkErrno: 76,
        parentTraversalErrno: 76,
        hiddenTargetSize: BigInt(new TextEncoder().encode("root target").byteLength),
      });

      expect(filesystem.stat("/outside/target").ino).toBe(hiddenTarget);
      expect(filesystem.stat("/m/target").ino).toBe(visibleTarget);
      const stillIntact = filesystem.open("/outside/target", 0);
      try {
        const bytes = new Uint8Array(11);
        expect(filesystem.read(stillIntact, bytes, 0n)).toBe(bytes.byteLength);
        expect(new TextDecoder().decode(bytes)).toBe("root target");
      } finally {
        filesystem.close(stillIntact);
      }
    } finally {
      await Promise.allSettled(runners.map((runner) => runner.close()));
      wakes.dispose();
      filesystem.dispose();
      rootFixture.close();
      overlayFixture.close();
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
  return {
    memory: instance.exports.memory as WebAssembly.Memory,
    run: (...args) => wasi.wasi.run(run, ...args) as Promise<number>,
    close: () => wasi.wasi.close(),
  };
}

async function open(
  runner: WasiImportRunner,
  dirFd: number,
  path: string,
  rightsBase: bigint,
): Promise<number> {
  const bytes = writePath(runner.memory, path);
  expect(await runner.run(dirFd, 0, PATH, bytes.byteLength, 0, rightsBase, 0n, 0, OPENED_FD)).toBe(
    0,
  );
  return new DataView(runner.memory.buffer).getUint32(OPENED_FD, true);
}

async function openErrno(
  runner: WasiImportRunner,
  dirFd: number,
  path: string,
  oflags: number,
): Promise<number> {
  const bytes = writePath(runner.memory, path);
  return runner.run(dirFd, 0, PATH, bytes.byteLength, oflags, 0n, 0n, 0, OPENED_FD);
}

async function readText(runner: WasiImportRunner, fd: number): Promise<string> {
  const view = new DataView(runner.memory.buffer);
  view.setUint32(IOV, DATA, true);
  view.setUint32(IOV + 4, READ_BYTES, true);
  expect(await runner.run(fd, IOV, 1, IOV + 8)).toBe(0);
  const count = view.getUint32(IOV + 8, true);
  return new TextDecoder().decode(new Uint8Array(runner.memory.buffer, DATA, count));
}

function writePath(memory: WebAssembly.Memory, path: string): Uint8Array {
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(memory.buffer, PATH, bytes.byteLength).set(bytes);
  return bytes;
}

function makeDirectory(
  storage: ReturnType<typeof createFacetSqliteStorage>,
  parent: bigint,
  name: string,
) {
  const inode = storage.create(parent, name, { type: "directory", exclusive: true });
  storage.release(inode);
  return inode;
}

function makeSymlink(
  storage: ReturnType<typeof createFacetSqliteStorage>,
  parent: bigint,
  name: string,
  target: string,
) {
  const inode = storage.create(parent, name, { type: "symlink", exclusive: true, target });
  storage.release(inode);
}

function makeFile(
  storage: ReturnType<typeof createFacetSqliteStorage>,
  parent: bigint,
  name: string,
  text: string,
) {
  const inode = storage.create(parent, name, { type: "file", exclusive: true });
  storage.write(inode, 0n, new TextEncoder().encode(text));
  storage.release(inode);
  return inode;
}
