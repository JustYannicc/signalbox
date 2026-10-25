import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import {
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelLowerFileSystemStorage } from "./KernelLowerFileSystemStorage.ts";
import { parentPath } from "./KernelLowerFileSystemSourceIndex.ts";
import { runKernelExecution } from "./process/KernelExecution.ts";
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
    const entries = [
      lowerEntry("/home", "directory", 0n, { mode: 0o755, uid: 0, gid: 0 }),
      lowerEntry("/home/node", "directory", 0n, { mode: 0o750, uid: 1000, gid: 1000 }),
      lowerEntry("/home/node/.bashrc", "file", BigInt(originalBytes.byteLength), {
        mode: 0o640,
        uid: 1000,
        gid: 1000,
      }),
    ];
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const calls = { read: [] as string[] };
    const source: KernelLowerFileSystemSource = {
      async lookup(paths) {
        return paths.map((path) => byPath.get(path));
      },
      async readdir(path) {
        if (byPath.get(path)?.stat.type !== "directory") return undefined;
        return entries.filter((entry) => entry.path !== path && parentPath(entry.path) === path);
      },
      async readlink() {
        throw Object.assign(new Error("Not a symlink"), { code: "EINVAL" });
      },
      async read(path, offset, length) {
        calls.read.push(path);
        return originalBytes.slice(Number(offset), Number(offset) + length);
      },
    };
    const lower = filesystem.installLowerFileSystem(source);
    const signal = new AbortController().signal;
    const mountedStorage = filesystem.resolve("/").mount.storage;
    if (!(mountedStorage instanceof KernelLowerFileSystemStorage)) {
      throw new Error("Expected the root filesystem to use the lower overlay");
    }
    const storage = mountedStorage;

    try {
      const lowerHome = await runKernelExecution(signal, () =>
        storage.lookup(storage.root, "home"),
      );
      const lowerNode = await runKernelExecution(signal, () => storage.lookup(lowerHome, "node"));
      const lowerFile = await runKernelExecution(signal, () =>
        storage.lookup(lowerNode, ".bashrc"),
      );
      const upperFile = await runKernelExecution(signal, () =>
        storage.create(lowerNode, "settings.bin", { type: "file", exclusive: true }),
      );
      try {
        await runKernelExecution(signal, () => storage.write(upperFile, 0n, writtenBytes));
      } finally {
        await runKernelExecution(signal, () => storage.release(upperFile));
      }
      await runKernelExecution(signal, () =>
        storage.rename(lowerNode, "settings.bin", lowerNode, "renamed-settings.bin"),
      );

      expect(calls.read).toEqual([]);
      const upperHome = await runKernelExecution(signal, () =>
        storage.lookup(storage.root, "home"),
      );
      const upperNode = await runKernelExecution(signal, () => storage.lookup(lowerHome, "node"));
      const upperSettings = await runKernelExecution(signal, () =>
        storage.lookup(lowerNode, "renamed-settings.bin"),
      );
      const stillLowerFile = await runKernelExecution(signal, () =>
        storage.lookup(lowerNode, ".bashrc"),
      );
      const entriesAfterCopyUp = await runKernelExecution(signal, () => storage.readdir(lowerNode));
      const directoryEdge = await runKernelExecution(signal, () =>
        storage.directoryEntry(lowerHome, lowerNode),
      );
      const lowerDirectoryStat = await runKernelExecution(signal, () => storage.stat(lowerNode));

      expect(upperHome).not.toBe(lowerHome);
      expect(upperNode).not.toBe(lowerNode);
      expect(upperSettings).toBe(upperFile);
      expect(stillLowerFile).toBe(lowerFile);
      expect(entriesAfterCopyUp.map((entry) => entry.name).sort()).toEqual([
        ".bashrc",
        "renamed-settings.bin",
      ]);
      expect(directoryEdge).toEqual({ name: "node", inode: upperNode, type: "directory" });
      expect(lowerDirectoryStat.type).toBe("directory");
      expect(filesystem.getPosixMetadata("/home/node")).toEqual({
        mode: 0o750,
        uid: 1000,
        gid: 1000,
      });

      const actualBytes = new Uint8Array(originalBytes.byteLength);
      expect(
        await runKernelExecution(signal, () => storage.readInto(lowerFile, 0n, actualBytes)),
      ).toBe(originalBytes.byteLength);
      expect(actualBytes).toEqual(originalBytes);
      expect(calls.read).toEqual(["/home/node/.bashrc"]);
    } finally {
      lower.dispose();
      filesystem.dispose();
      database.close();
    }
  });
});
