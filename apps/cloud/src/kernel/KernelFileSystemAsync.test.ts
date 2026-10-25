import { describe, expect, it } from "vite-plus/test";
import { createNodeFs } from "../isolate/NodeFs.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import {
  KernelFileSystemUnavailable,
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

function entry(
  path: string,
  type: KernelLowerFileSystemEntry["stat"]["type"],
  size = 0n,
): KernelLowerFileSystemEntry {
  return {
    path,
    stat: { type, size, nlink: 1n, atimeNs: 1n, mtimeNs: 2n, ctimeNs: 3n },
    metadata: { mode: 0o755, uid: 1000, gid: 1000 },
  };
}

function fixture() {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const files = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
  });
  const fs = createNodeFs(files).fs;
  const entries = new Map<string, KernelLowerFileSystemEntry>();
  const links = new Map<string, string>();
  const requests: string[] = [];
  const source: KernelLowerFileSystemSource = {
    async lookup(paths) {
      requests.push(...paths);
      return paths.map((path) => entries.get(path));
    },
    async readdir(path) {
      return [...entries.values()].filter(
        (child) => child.path !== path && child.path.slice(0, child.path.lastIndexOf("/")) === path,
      );
    },
    async readlink(path) {
      const target = links.get(path);
      if (target === undefined) throw new Error("Unexpected readlink");
      return target;
    },
    async read() {
      throw new Error("Metadata operations must not read lower bytes");
    },
  };
  return {
    files,
    fs,
    storage,
    entries,
    links,
    requests,
    source,
    close() {
      files.dispose();
      database.close();
    },
  };
}

describe("public asynchronous filesystem metadata", () => {
  it("merges live lower directories while upper files retain their metadata and bytes", async () => {
    const test = fixture();
    test.fs.mkdirSync("/work");
    test.fs.writeFileSync("/work/shared", "upper bytes");
    for (const value of [
      entry("/work", "directory"),
      entry("/work/shared", "file", 999n),
      entry("/work/lower", "file", 7n),
    ])
      test.entries.set(value.path, value);
    const lower = test.files.installLowerFileSystem(test.source);
    try {
      expect((await test.files.readdirAsync("/work")).sort()).toEqual(["lower", "shared"]);
      expect(await test.files.statAsync("/work/shared")).toMatchObject({
        size: 11n,
        posix: { uid: 1000, mode: 0o644 },
      });
      expect(await test.files.lstatAsync("/work/lower")).toMatchObject({
        size: 7n,
        posix: { uid: 1000 },
      });
      expect(test.fs.readFileSync("/work/shared", "utf8")).toBe("upper bytes");
      expect(test.requests).toContain("/work");
    } finally {
      lower.dispose();
      test.close();
    }
  });

  it("preserves physical symlink parents and follows symlinks before parent segments", async () => {
    const test = fixture();
    test.fs.mkdirSync("/bin");
    const values = [
      entry("/bin/link", "symlink", 12n),
      entry("/usr", "directory"),
      entry("/usr/bin", "directory"),
      entry("/usr/share", "directory"),
      entry("/usr/share/target", "file", 41n),
      entry("/alias", "symlink"),
      entry("/machine", "directory"),
      entry("/machine/dir", "directory"),
      entry("/machine/dir/sub", "directory"),
      entry("/machine/dir/leaf", "file", 23n),
    ];
    for (const value of values) test.entries.set(value.path, value);
    test.entries.set("/bin/link", { ...test.entries.get("/bin/link")!, symlinkParent: "/usr/bin" });
    test.links.set("/bin/link", "../share/target");
    test.links.set("/alias", "/machine/dir/sub");
    const lower = test.files.installLowerFileSystem(test.source);
    try {
      expect(await test.files.statAsync("/bin/link")).toMatchObject({ type: "file", size: 41n });
      expect(await test.files.lstatAsync("/bin/link")).toMatchObject({
        type: "symlink",
        size: 12n,
      });
      expect(await test.files.statAsync("/alias/../leaf")).toMatchObject({
        type: "file",
        size: 23n,
      });
    } finally {
      lower.dispose();
      test.close();
    }
  });

  it("keeps ancestor search and directory read permissions authoritative", async () => {
    const test = fixture();
    test.entries.set("/private", {
      ...entry("/private", "directory"),
      metadata: { mode: 0o700, uid: 0, gid: 0 },
    });
    test.entries.set("/private/file", entry("/private/file", "file"));
    test.entries.set("/search-only", {
      ...entry("/search-only", "directory"),
      metadata: { mode: 0o111, uid: 0, gid: 0 },
    });
    const lower = test.files.installLowerFileSystem(test.source);
    try {
      await expect(test.files.statAsync("/private/file")).rejects.toMatchObject({ code: "EACCES" });
      await expect(test.files.lstatAsync("/private/file")).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(test.files.readdirAsync("/search-only")).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      lower.dispose();
      test.close();
    }
  });

  it.each(["statAsync", "lstatAsync", "readdirAsync"] as const)(
    "%s preserves source failures and aborts across a lookup await",
    async (method) => {
      const test = fixture();
      const started = Promise.withResolvers<AbortSignal | undefined>();
      const result = Promise.withResolvers<readonly (KernelLowerFileSystemEntry | undefined)[]>();
      const lower = test.files.installLowerFileSystem({
        ...test.source,
        lookup: async (_paths, signal) => {
          started.resolve(signal);
          return result.promise;
        },
      });
      const controller = new AbortController();
      const reason = new Error("metadata lookup cancelled");
      try {
        const operation = test.files[method]("/pending", controller.signal);
        expect(await started.promise).toBe(controller.signal);
        controller.abort(reason);
        result.resolve([entry("/pending", "directory")]);
        await expect(operation).rejects.toBe(reason);
        lower.invalidate();
        const unavailable = new KernelFileSystemUnavailable("lookup backend failed");
        lower.dispose();
        const failed = test.files.installLowerFileSystem({
          ...test.source,
          lookup: async () => {
            throw unavailable;
          },
        });
        try {
          await expect(test.files[method]("/failed")).rejects.toBe(unavailable);
        } finally {
          failed.dispose();
        }
      } finally {
        lower.dispose();
        test.close();
      }
    },
  );

  it("rejects an already aborted request without starting lower I/O", async () => {
    const test = fixture();
    const lower = test.files.installLowerFileSystem(test.source);
    const reason = new Error("already aborted");
    try {
      await expect(test.files.statAsync("/absent", AbortSignal.abort(reason))).rejects.toBe(reason);
      expect(test.requests).toEqual([]);
    } finally {
      lower.dispose();
      test.close();
    }
  });

  it("prepares an actual new transcript path before appending canonical bytes after invalidation", async () => {
    const test = fixture();
    test.fs.mkdirSync("/transcripts");
    const lower = test.files.installLowerFileSystem(test.source);
    const path = "/transcripts/selected-native-session.jsonl";
    const row = '{"type":"assistant","message":{"content":"✓ exact\\nbytes"}}\n';
    try {
      lower.invalidate();
      await test.files.prepareLowerPaths([path]);
      await test.fs.promises.appendFile(path, row);
      expect(test.requests).toContain(path);
      expect(test.fs.readFileSync(path, "utf8")).toBe(row);
    } finally {
      lower.dispose();
      test.close();
    }
  });

  it.each(["prepare failure", "prepare abort", "append read-only failure"])(
    "does not create a transcript after %s",
    async (kind) => {
      const test = fixture();
      test.fs.mkdirSync("/transcripts");
      const directory = test.files.resolve("/transcripts").inode;
      const controller = new AbortController();
      const failure = new KernelFileSystemUnavailable("transcript lookup failed");
      const lower = test.files.installLowerFileSystem({
        ...test.source,
        lookup: async (paths) => {
          if (kind === "prepare failure") throw failure;
          if (kind === "prepare abort") controller.abort(failure);
          return paths.map((path) =>
            kind === "append read-only failure" && path === "/transcripts/selected.jsonl"
              ? entry(path, "file")
              : undefined,
          );
        },
      });
      const write = async () => {
        await test.files.prepareLowerPaths(["/transcripts/selected.jsonl"], controller.signal);
        await test.fs.promises.appendFile("/transcripts/selected.jsonl", '{"type":"user"}\n', {
          signal: controller.signal,
        });
      };
      try {
        if (kind === "append read-only failure")
          await expect(write()).rejects.toMatchObject({ code: "EROFS" });
        else await expect(write()).rejects.toBe(failure);
        expect(() => test.storage.lookup(directory, "selected.jsonl")).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
      } finally {
        lower.dispose();
        test.close();
      }
    },
  );
});
