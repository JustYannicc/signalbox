import { describe, expect, it } from "vite-plus/test";
import { createNodeFs } from "../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import type {
  KernelLowerFileSystemDirectoryResult,
  KernelLowerFileSystemEntry,
  KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function kernelEntry(path: string, type: "file" | "directory"): KernelLowerFileSystemEntry {
  return {
    path,
    stat: {
      type,
      size: 0n,
      nlink: type === "directory" ? 2n : 1n,
      atimeNs: 1n,
      mtimeNs: 1n,
      ctimeNs: 1n,
    },
    metadata: { mode: type === "directory" ? 0o755 : 0o644, uid: 1000, gid: 1000 },
  };
}

function directoryListing(entries: readonly KernelLowerFileSystemEntry[]) {
  return { kind: "entries" as const, entries };
}

function makeEpochSource(
  readdirMany: (
    paths: readonly string[],
  ) => Promise<readonly KernelLowerFileSystemDirectoryResult[]>,
): KernelLowerFileSystemSource {
  const root = kernelEntry("/", "directory");
  const usr = kernelEntry("/usr", "directory");
  const known = new Map([
    ["/", root],
    ["/usr", usr],
  ]);
  return {
    lookup: async (paths) => paths.map((path) => known.get(path)),
    lookupKnown: (paths) => paths.map((path) => known.get(path)),
    readdir: async (path) => (path === "/usr" ? [kernelEntry("/usr/newer", "file")] : []),
    readdirMany,
    readlink: async () => {
      throw Object.assign(new Error("Not a symlink"), { code: "EINVAL" });
    },
    readlinkMany: async () => [],
    read: async () => new Uint8Array(),
  };
}

function makeEpochFilesystem() {
  const database = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
  });
  return {
    filesystem,
    fs: createNodeFs(filesystem).fs,
    close() {
      filesystem.dispose();
      database.close();
    },
  };
}

describe("lower filesystem refresh ownership", () => {
  it("does not let a late same-attachment refresh failure clear a newer snapshot", async () => {
    const fixture = makeEpochFilesystem();
    const started = Promise.withResolvers<void>();
    const oldBatch = Promise.withResolvers<readonly KernelLowerFileSystemDirectoryResult[]>();
    let batchCount = 0;
    const attachment = fixture.filesystem.installLowerFileSystem(
      makeEpochSource(async (paths) => {
        batchCount++;
        if (batchCount === 1) {
          started.resolve();
          return oldBatch.promise;
        }
        return paths.map(() => directoryListing([kernelEntry("/usr/newer", "file")]));
      }),
    );
    try {
      const oldRefresh = attachment.refresh(["/usr"]);
      await started.promise;
      await attachment.refresh(["/usr"]);
      await attachment.prepare(["/usr"]);
      expect(fixture.fs.readdirSync("/usr")).toContain("newer");

      oldBatch.reject(new Error("late transport failure"));
      await expect(oldRefresh).rejects.toBeDefined();
      expect(fixture.fs.readdirSync("/usr")).toContain("newer");
    } finally {
      attachment.dispose();
      fixture.close();
    }
  });

  it("does not let a detached attachment clear its replacement's snapshot", async () => {
    const fixture = makeEpochFilesystem();
    const started = Promise.withResolvers<void>();
    const oldBatch = Promise.withResolvers<readonly KernelLowerFileSystemDirectoryResult[]>();
    const oldAttachment = fixture.filesystem.installLowerFileSystem(
      makeEpochSource(async () => {
        started.resolve();
        return oldBatch.promise;
      }),
    );
    let newAttachment: ReturnType<typeof fixture.filesystem.installLowerFileSystem> | undefined;
    try {
      const oldRefresh = oldAttachment.refresh(["/usr"]);
      await started.promise;
      oldAttachment.dispose();
      newAttachment = fixture.filesystem.installLowerFileSystem(
        makeEpochSource(async (paths) =>
          paths.map(() => directoryListing([kernelEntry("/usr/newer", "file")])),
        ),
      );
      await newAttachment.refresh(["/usr"]);
      await newAttachment.prepare(["/usr"]);

      oldBatch.reject(new Error("detached source failed"));
      await expect(oldRefresh).rejects.toBeDefined();
      expect(fixture.fs.readdirSync("/usr")).toContain("newer");
    } finally {
      newAttachment?.dispose();
      oldAttachment.dispose();
      fixture.close();
    }
  });
});
