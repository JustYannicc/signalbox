import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const now = () => 1_800_000_000_000_000_001n;
const bytes = (text: string) => new TextEncoder().encode(text);

describe("KernelFileSystem", () => {
  it("shares file offsets and append status with the WASI descriptor table", async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    const wakes = new KernelWakeRegistry();
    try {
      const fd = fs.open("/shared", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
      fs.write(fd, bytes("abc"), 0n);
      const first = new Uint8Array(1);
      expect(fs.read(fd, first, null)).toBe(1);
      expect(first[0]).toBe("a".charCodeAt(0));

      const reader = createKernelAsyncWasi({ filesystem: fs, wakes });
      const readerInstance = new WebAssembly.Instance(
        wasmImportReactor(
          "wasi_snapshot_preview1",
          "fd_read",
          ["i32", "i32", "i32", "i32"],
          ["i32"],
        ),
        reader.wasi.getImportObject(),
      );
      await reader.wasi.initialize(readerInstance);
      const readerMemory = guestMemory(readerInstance);
      const readerView = new DataView(readerMemory.buffer);
      readerView.setUint32(64, 128, true);
      readerView.setUint32(68, 2, true);
      expect(await reader.wasi.run(guestRun(readerInstance), fd, 64, 1, 80)).toBe(0);
      expect(readerView.getUint32(80, true)).toBe(2);
      expect(new TextDecoder().decode(new Uint8Array(readerMemory.buffer, 128, 2))).toBe("bc");
      await reader.wasi.close();

      fs.close(fd);
      const appendFd = fs.open(
        "/append",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_APPEND,
      );
      fs.write(appendFd, bytes("a"), null);
      const alias = fs.descriptors.duplicate(appendFd);
      const writer = createKernelAsyncWasi({ filesystem: fs, wakes });
      const writerInstance = new WebAssembly.Instance(
        wasmImportReactor(
          "wasi_snapshot_preview1",
          "fd_write",
          ["i32", "i32", "i32", "i32"],
          ["i32"],
        ),
        writer.wasi.getImportObject(),
      );
      await writer.wasi.initialize(writerInstance);
      const writerMemory = guestMemory(writerInstance);
      const writerView = new DataView(writerMemory.buffer);
      writerView.setUint32(64, 128, true);
      writerView.setUint32(68, 1, true);
      new Uint8Array(writerMemory.buffer, 128, 1).set(bytes("b"));
      expect(await writer.wasi.run(guestRun(writerInstance), alias, 64, 1, 80)).toBe(0);
      expect(writerView.getUint32(80, true)).toBe(1);
      await writer.wasi.close();
      expect(storage.stat(fs.resolve("/append").inode).size).toBe(2n);
      const appendRead = fs.open("/append", KernelOpenFlags.O_RDONLY);
      const appended = new Uint8Array(2);
      expect(fs.read(appendRead, appended, null)).toBe(2);
      expect(new TextDecoder().decode(appended)).toBe("ab");
    } finally {
      wakes.dispose();
      fs.dispose();
      fixture.close();
    }
  });

  it("keeps O_PATH descriptors metadata-only and reopens proc aliases independently", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      const writer = fs.open("/file", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
      fs.write(writer, bytes("first"), 0n);
      const pathFd = fs.open("/file", KernelOpenFlags.O_PATH);
      expect(fs.fstat(pathFd)).toMatchObject({ type: "file", ino: fs.stat("/file").ino });
      expect(() => fs.read(pathFd, new Uint8Array(1), null)).toThrow(
        expect.objectContaining({ code: "EBADF" }),
      );

      const original = fs.open("/file", KernelOpenFlags.O_RDONLY);
      expect(fs.read(original, new Uint8Array(2), null)).toBe(2);
      const reopened = fs.open(`/proc/self/fd/${original}`, KernelOpenFlags.O_RDONLY);
      const fromStart = new Uint8Array(5);
      expect(fs.read(reopened, fromStart, null)).toBe(5);
      expect(new TextDecoder().decode(fromStart)).toBe("first");
      expect(fs.realpath(`/proc/self/fd/${original}`)).toBe("/file");
      expect(fs.lstat(`/proc/self/fd/${original}`).type).toBe("symlink");

      const zero = fs.open("/dev/zero", KernelOpenFlags.O_RDONLY);
      const zeros = new Uint8Array(8).fill(0xff);
      expect(fs.read(zero, zeros, null)).toBe(8);
      expect(zeros).toEqual(new Uint8Array(8));
      expect(fs.fstat(zero)).toMatchObject({ type: "character", ino: 2n, dev: 0n });
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("uses the shared inode layer for links, timestamps, truncation, and sync mode", () => {
    const fixture = sqliteFixture();
    const baseStorage = createFacetSqliteStorage(fixture.storage, now);
    const syncModes: boolean[] = [];
    const storage = {
      ...baseStorage,
      sync(inode: bigint, dataOnly: boolean) {
        syncModes.push(dataOnly);
        baseStorage.sync(inode, dataOnly);
      },
    };
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      fs.mkdir("/files");
      const fd = fs.open("/files/original", KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR);
      fs.write(fd, bytes("data"), 0n);
      fs.setTimes("/files/original", { atimeNs: 11n, mtimeNs: 12n });
      fs.symlink("original", "/files/symlink");
      expect(fs.readlink("/files/symlink")).toBe("original");
      expect(fs.lstat("/files/symlink").type).toBe("symlink");
      expect(fs.stat("/files/symlink")).toMatchObject({ type: "file", size: 4n });

      fs.link("/files/original", "/files/hardlink");
      expect(fs.stat("/files/hardlink").ino).toBe(fs.stat("/files/original").ino);
      fs.rename("/files/hardlink", "/files/renamed");
      expect(fs.readdir("/files")).toEqual(["original", "renamed", "symlink"]);
      fs.truncate("/files/renamed", 2n);
      expect(fs.stat("/files/renamed").size).toBe(2n);

      fs.fsetTimes(fd, { atimeNs: 13n });
      expect(fs.fstat(fd).atimeNs).toBe(13n);
      fs.sync(fd, true);
      expect(syncModes).toEqual([true]);
      fs.close(fd);
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("duplicates stdio aliases and exposes null, zero, and random devices", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const output: string[] = [];
    const fs = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      stdio: [
        { readInto: () => 0 },
        {
          write(source) {
            output.push(new TextDecoder().decode(source));
            return source.byteLength;
          },
        },
        { write: (source) => source.byteLength },
      ],
    });
    try {
      const stdout = fs.open("/dev/stdout", KernelOpenFlags.O_WRONLY);
      expect(fs.write(stdout, bytes("out"), null)).toBe(3);
      expect(output).toEqual(["out"]);
      fs.close(stdout);

      const nullDevice = fs.open("/dev/null", KernelOpenFlags.O_RDWR);
      expect(fs.read(nullDevice, new Uint8Array(4), null)).toBe(0);
      expect(fs.write(nullDevice, bytes("ignored"), null)).toBe(7);
      expect(fs.fstat(nullDevice).type).toBe("character");
      fs.close(nullDevice);

      const zero = fs.open("/dev/zero", KernelOpenFlags.O_RDONLY);
      const zeroes = new Uint8Array(4).fill(1);
      expect(fs.read(zero, zeroes, null)).toBe(4);
      expect(zeroes).toEqual(new Uint8Array(4));
      fs.close(zero);

      const random = fs.open("/dev/random", KernelOpenFlags.O_RDONLY);
      expect(fs.read(random, new Uint8Array(4), null)).toBe(4);
      expect(fs.fstat(random).type).toBe("character");
      fs.close(random);
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("rejects absolute symlinks that cross configured mount roots", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({
      mounts: [
        { path: "/", storage },
        { path: "/other", storage },
      ],
    });
    try {
      expect(() => fs.symlink("/other/file", "/crossing")).toThrow(
        expect.objectContaining({ code: "ENOTSUP" }),
      );
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("forks the retained cwd anchor without rewalking its stale path and releases it per process", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    let child: KernelFileSystem | undefined;
    try {
      fs.mkdir("/working");
      const cwdInode = fs.resolve("/working").inode;
      const mount = fs.resolve("/").mount;
      fs.chdir("/working");
      fs.rmdir("/working");
      expect(() => fs.cwd).toThrow(expect.objectContaining({ code: "ESTALE" }));

      child = fs.fork(fs.descriptors.fork([]));
      expect(child.resolve("/").mount).toBe(mount);
      expect(() => child!.cwd).toThrow(expect.objectContaining({ code: "ESTALE" }));
      expect(storage.stat(cwdInode)).toMatchObject({ type: "directory", nlink: 0n });

      fs.dispose();
      expect(storage.stat(cwdInode)).toMatchObject({ type: "directory", nlink: 0n });
      child.dispose();
      child = undefined;
      expect(() => storage.stat(cwdInode)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      child?.dispose();
      fs.dispose();
      fixture.close();
    }
  });

  it("refreshes same-parent renames through the shared resolver", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    try {
      fs.mkdir("/parent");
      fs.mkdir("/parent/old");
      fs.mkdir("/parent/old/sub");
      const directoryFd = fs.open(
        "/parent/old/sub",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      fs.chdir("/parent/old/sub");

      fs.rename("/parent/old", "/parent/new");
      expect(fs.cwd).toBe("/parent/new/sub");
      fs.fchdir(directoryFd);
      expect(fs.cwd).toBe("/parent/new/sub");

      const fileFd = fs.open(
        "/parent/new/sub/file",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_RDWR,
      );
      fs.rename("/parent/new/sub/file", "/parent/new/sub/renamed");
      expect(fs.realpath(`/proc/self/fd/${fileFd}`)).toBe("/parent/new/sub/renamed");
      fs.close(fileFd);
      fs.close(directoryFd);
    } finally {
      fs.dispose();
      fixture.close();
    }
  });

  it("fails closed after a cwd directory moves across parents, including dot and fork", () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, now);
    const fs = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    let child: KernelFileSystem | undefined;
    try {
      fs.mkdir("/before");
      fs.mkdir("/after");
      fs.mkdir("/before/work");
      const work = fs.resolve("/before/work").inode;
      fs.chdir("/before/work");
      fs.rename("/before/work", "/after/work");

      expect(() => fs.cwd).toThrow(expect.objectContaining({ code: "ESTALE" }));
      expect(() => fs.resolve(".")).toThrow(expect.objectContaining({ code: "ESTALE" }));
      expect(fs.resolve("/after/work").inode).toBe(work);

      child = fs.fork(fs.descriptors.fork([]));
      expect(() => child!.cwd).toThrow(expect.objectContaining({ code: "ESTALE" }));
      expect(() => child!.resolve(".")).toThrow(expect.objectContaining({ code: "ESTALE" }));
    } finally {
      child?.dispose();
      fs.dispose();
      fixture.close();
    }
  });
});

function guestMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = (instance.exports as { memory?: unknown }).memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory export is missing");
  return memory;
}

function guestRun(instance: WebAssembly.Instance): (...args: Array<number | bigint>) => unknown {
  const run = (instance.exports as { run?: unknown }).run;
  if (typeof run !== "function") throw new Error("Guest run export is missing");
  return run as (...args: Array<number | bigint>) => unknown;
}
