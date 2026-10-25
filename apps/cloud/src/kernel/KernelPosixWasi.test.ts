import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const now = () => 1_800_000_000_000_000_001n;
const rootMetadata = { mode: 0o755, uid: 1000, gid: 1000 } as const;
const credentials = { uid: 1000, gid: 1000, euid: 1000, egid: 1000 } as const;
const rootFd = 3;
const createFlag = 1;
const pathOpenParams = ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"] as const;
const pathPointer = 64;
const secondPathPointer = 128;
const openedFdPointer = 256;

describe("Kernel WASI POSIX creation metadata", () => {
  it("applies default and explicit modes through real WASI creation imports", async () => {
    const context = setup();
    const runners: WasiImportRunner[] = [];
    try {
      const pathOpen = await wasiRunner(
        context.filesystem,
        context.wakes,
        "path_open",
        pathOpenParams,
      );
      runners.push(pathOpen);
      const pathCreateDirectory = await wasiRunner(
        context.filesystem,
        context.wakes,
        "path_create_directory",
        ["i32", "i32", "i32"],
      );
      runners.push(pathCreateDirectory);
      const pathSymlink = await wasiRunner(context.filesystem, context.wakes, "path_symlink", [
        "i32",
        "i32",
        "i32",
        "i32",
        "i32",
      ]);
      runners.push(pathSymlink);

      expect(context.filesystem.getPosixMetadata("/")).toEqual(rootMetadata);
      expect(context.filesystem.descriptors.get(rootFd)).toMatchObject({
        kind: "directory",
        preopen: true,
      });

      const fileFd = await createFile(pathOpen, "file");
      expect(context.filesystem.stat("/file").type).toBe("file");
      expect(context.filesystem.getPosixMetadata("/file")).toEqual({
        mode: 0o644,
        uid: 1000,
        gid: 1000,
      });
      context.filesystem.close(fileFd);

      writeGuestPath(pathCreateDirectory.memory, pathPointer, "directory");
      expect(await pathCreateDirectory.run(rootFd, pathPointer, "directory".length)).toBe(0);
      expect(context.filesystem.stat("/directory").type).toBe("directory");
      expect(context.filesystem.getPosixMetadata("/directory")).toEqual({
        mode: 0o755,
        uid: 1000,
        gid: 1000,
      });

      writeGuestPath(pathSymlink.memory, pathPointer, "missing-target");
      writeGuestPath(pathSymlink.memory, secondPathPointer, "link");
      expect(
        await pathSymlink.run(
          pathPointer,
          "missing-target".length,
          rootFd,
          secondPathPointer,
          "link".length,
        ),
      ).toBe(0);
      expect(context.filesystem.lstat("/link").type).toBe("symlink");
      expect(context.filesystem.getPosixMetadata("/link", false)).toEqual({
        mode: 0o777,
        uid: 1000,
        gid: 1000,
      });

      context.filesystem.setNextCreateMode(0o600);
      const privateFd = await createFile(pathOpen, "private");
      expect(context.filesystem.stat("/private").type).toBe("file");
      expect(context.filesystem.getPosixMetadata("/private")).toEqual({
        mode: 0o600,
        uid: 1000,
        gid: 1000,
      });
      context.filesystem.close(privateFd);
    } finally {
      await Promise.allSettled(runners.map((runner) => runner.close()));
      await context.close();
    }
  });

  it("clears a mode hint on an existing open or invalid descriptor", async () => {
    const context = setup();
    let runner: WasiImportRunner | undefined;
    try {
      runner = await wasiRunner(context.filesystem, context.wakes, "path_open", pathOpenParams);
      const existingFd = await createFile(runner, "existing");
      context.filesystem.close(existingFd);

      context.filesystem.setNextCreateMode(0o600);
      const reopenedFd = await createFile(runner, "existing");
      context.filesystem.close(reopenedFd);
      const afterExistingFd = await createFile(runner, "after-existing");
      context.filesystem.close(afterExistingFd);
      expect(context.filesystem.getPosixMetadata("/existing").mode).toBe(0o644);
      expect(context.filesystem.getPosixMetadata("/after-existing").mode).toBe(0o644);

      context.filesystem.setNextCreateMode(0o600);
      writeGuestPath(runner.memory, pathPointer, "invalid-fd");
      expect(
        await runner.run(
          99,
          0,
          pathPointer,
          "invalid-fd".length,
          createFlag,
          0n,
          0n,
          0,
          openedFdPointer,
        ),
      ).toBe(8);
      const afterInvalidFd = await createFile(runner, "after-invalid-fd");
      context.filesystem.close(afterInvalidFd);
      expect(context.filesystem.getPosixMetadata("/after-invalid-fd")).toEqual({
        mode: 0o644,
        uid: 1000,
        gid: 1000,
      });
    } finally {
      await runner?.close();
      await context.close();
    }
  });
});

interface WasiImportRunner {
  readonly memory: WebAssembly.Memory;
  run(...args: Array<number | bigint>): Promise<number>;
  close(): Promise<void>;
}

function setup() {
  const fixture = sqliteFixture();
  const storage = createFacetSqliteStorage(fixture.storage, now);
  storage.posix.initialize(storage.root, rootMetadata);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials, umask: 0o022 },
  });
  const wakes = new KernelWakeRegistry();
  return {
    filesystem,
    wakes,
    async close() {
      wakes.dispose();
      filesystem.dispose();
      fixture.close();
    },
  };
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

async function createFile(runner: WasiImportRunner, path: string): Promise<number> {
  writeGuestPath(runner.memory, pathPointer, path);
  const errno = await runner.run(
    rootFd,
    0,
    pathPointer,
    path.length,
    createFlag,
    0n,
    0n,
    0,
    openedFdPointer,
  );
  expect(errno).toBe(0);
  return new DataView(runner.memory.buffer).getUint32(openedFdPointer, true);
}

function writeGuestPath(memory: WebAssembly.Memory, pointer: number, path: string): void {
  const bytes = new TextEncoder().encode(path);
  new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
}
