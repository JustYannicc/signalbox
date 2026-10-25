import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import {
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const originalBytes = Uint8Array.from([0, 255, 1, 128, 10]);
const writtenBytes = Uint8Array.from([18, 0, 44]);

function lowerEntry(
  path: string,
  type: KernelLowerFileSystemEntry["stat"]["type"],
  size = 0n,
  metadata = { mode: 0o755, uid: 41, gid: 42 },
): KernelLowerFileSystemEntry {
  return {
    path,
    stat: {
      type,
      size,
      nlink: type === "directory" ? 2n : 1n,
      atimeNs: 1n,
      mtimeNs: 2n,
      ctimeNs: 3n,
    },
    metadata,
  };
}

describe("KernelLowerFileSystemDirectoryLayer", () => {
  it("copies an async lower parent chain up while preserving lower bytes and old references", async () => {
    const database = sqliteFixture();
    const upper = createFacetSqliteStorage(database.storage, () => 1n);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage: upper }] });
    const lowerPath = "/home/node/.bashrc";
    const writtenPath = "/home/node/settings.bin";
    const renamedPath = "/home/node/renamed-settings.bin";
    const entries = [
      lowerEntry("/home", "directory", 0n, { mode: 0o755, uid: 0, gid: 0 }),
      lowerEntry("/home/node", "directory", 0n, { mode: 0o750, uid: 1000, gid: 1000 }),
      lowerEntry(lowerPath, "file", BigInt(originalBytes.byteLength), {
        mode: 0o640,
        uid: 1000,
        gid: 1000,
      }),
    ];
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const calls = { read: [] as string[] };
    const originalBefore = originalBytes.slice();
    const source: KernelLowerFileSystemSource = {
      async lookup(paths) {
        return paths.map((path) => byPath.get(path));
      },
      async readdir(path) {
        if (byPath.get(path)?.stat.type !== "directory") return undefined;
        return entries.filter((entry) => {
          const separator = entry.path.lastIndexOf("/");
          const parent = entry.path.slice(0, separator) || "/";
          return entry.path !== path && parent === path;
        });
      },
      async readlink() {
        throw Object.assign(new Error("Not a symlink"), { code: "EINVAL" });
      },
      readSync(path, offset, length) {
        calls.read.push(path);
        return originalBytes.slice(Number(offset), Number(offset) + length);
      },
      async read(path, offset, length) {
        calls.read.push(path);
        return originalBytes.slice(Number(offset), Number(offset) + length);
      },
    };
    const lower = filesystem.installLowerFileSystem(source);
    const opened: number[] = [];

    try {
      await filesystem.prepareLowerPaths(["/home", "/home/node", lowerPath]);
      const lowerHome = filesystem.open(
        "/home",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      opened.push(lowerHome);
      const lowerHomeBefore = filesystem.fstat(lowerHome);
      const lowerNode = filesystem.open(
        "/home/node",
        KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_DIRECTORY,
      );
      opened.push(lowerNode);
      const lowerNodeBefore = filesystem.fstat(lowerNode);
      const lowerFile = filesystem.open(lowerPath, KernelOpenFlags.O_RDONLY);
      opened.push(lowerFile);
      const lowerFileBefore = filesystem.fstat(lowerFile);

      const upperFile = await filesystem.openAsync(
        writtenPath,
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_EXCL | KernelOpenFlags.O_WRONLY,
        0o600,
      );
      try {
        expect(filesystem.write(upperFile, writtenBytes, 0n)).toBe(writtenBytes.byteLength);
      } finally {
        filesystem.close(upperFile);
      }
      await filesystem.renameAsync(writtenPath, renamedPath);

      expect(calls.read).toEqual([]);
      const homeStat = await filesystem.statAsync("/home");
      const nodeStat = await filesystem.statAsync("/home/node");
      const lowerFileStat = await filesystem.statAsync(lowerPath);
      const renamedStat = await filesystem.statAsync(renamedPath);
      const entriesAfterCopyUp = await filesystem.readdirAsync("/home/node");
      expect(homeStat.type).toBe("directory");
      expect(homeStat.ino).not.toBe(lowerHomeBefore.ino);
      expect(nodeStat.type).toBe("directory");
      expect(nodeStat.ino).not.toBe(lowerNodeBefore.ino);
      expect(renamedStat).toMatchObject({ type: "file", size: BigInt(writtenBytes.byteLength) });
      expect(lowerFileStat).toMatchObject({
        type: "file",
        ino: lowerFileBefore.ino,
        size: BigInt(originalBytes.byteLength),
      });
      expect(filesystem.fstat(lowerFile)).toMatchObject({
        type: "file",
        ino: lowerFileBefore.ino,
        size: BigInt(originalBytes.byteLength),
      });
      expect(filesystem.fstat(lowerHome)).toMatchObject({
        type: "directory",
        ino: lowerHomeBefore.ino,
      });
      expect(filesystem.fstat(lowerNode)).toMatchObject({
        type: "directory",
        ino: lowerNodeBefore.ino,
      });
      expect(entriesAfterCopyUp.sort()).toEqual([".bashrc", "renamed-settings.bin"]);
      expect(filesystem.getPosixMetadata("/home/node")).toEqual({
        mode: 0o750,
        uid: 1000,
        gid: 1000,
      });

      const upperSettings = filesystem.open(renamedPath, KernelOpenFlags.O_RDONLY);
      opened.push(upperSettings);
      const actualWrittenBytes = new Uint8Array(writtenBytes.byteLength);
      expect(filesystem.read(upperSettings, actualWrittenBytes, 0n)).toBe(writtenBytes.byteLength);
      expect(actualWrittenBytes).toEqual(writtenBytes);

      const actualLowerBytes = new Uint8Array(originalBytes.byteLength);
      expect(filesystem.read(lowerFile, actualLowerBytes, 0n)).toBe(originalBytes.byteLength);
      expect(actualLowerBytes).toEqual(originalBytes);
      expect(originalBytes).toEqual(originalBefore);
      expect(calls.read).toEqual([lowerPath]);
    } finally {
      for (let index = opened.length - 1; index >= 0; index--) {
        const fd = opened[index];
        if (fd !== undefined) filesystem.close(fd);
      }
      lower.dispose();
      filesystem.dispose();
      database.close();
    }
  });
});
