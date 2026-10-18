import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { CreateOptions } from "../storage.ts";
import { createFacetSqliteStorage, type FacetStorage } from "../FacetSqliteStorage.ts";

const databases: NodeSqlite.DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const fixture = () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  databases.push(db);
  let now = 900719925474099312345n;
  let rejectCommit = false;
  const storage: FacetStorage = {
    sql: {
      databaseSize: 0,
      exec: (query, ...bindings) =>
        db
          .prepare(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          ),
    },
    transactionSync: (callback) => {
      db.exec("BEGIN");
      try {
        const result = callback();
        if (rejectCommit) {
          rejectCommit = false;
          throw new Error("commit failed");
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const nowNs = () => now;
  const fs = createFacetSqliteStorage(storage, nowNs);
  const file = (name = "file", parent = fs.root) =>
    fs.create(parent, name, { type: "file", exclusive: true });
  const directory = (name: string, parent = fs.root) =>
    fs.create(parent, name, { type: "directory", exclusive: true });
  return {
    db,
    storage,
    fs,
    nowNs,
    file,
    directory,
    tick: () => ++now,
    rejectCommit: () => {
      rejectCommit = true;
    },
  };
};

const error = (code: string) => expect.objectContaining({ code });

describe("facet SQLite inode behavior", () => {
  it("roundtrips exact bigint metadata and stores symbolic types", () => {
    const { fs, nowNs, file, tick, db } = fixture();
    expect(fs.root).toBe(1n);
    expect(fs.stat(fs.root)).toEqual({
      type: "directory",
      size: 0n,
      nlink: 2n,
      atimeNs: nowNs(),
      mtimeNs: nowNs(),
      ctimeNs: nowNs(),
    });
    const inode = file();
    const ctimeNs = tick();
    fs.setTimes(inode, { atimeNs: -12345678901234567890n, mtimeNs: 12345678901234567890n });
    expect(fs.stat(inode)).toEqual({
      type: "file",
      size: 0n,
      nlink: 1n,
      atimeNs: -12345678901234567890n,
      mtimeNs: 12345678901234567890n,
      ctimeNs,
    });
    expect(
      db
        .prepare(
          "SELECT typeof(ino) AS ino, typeof(size) AS size, typeof(atime_ns) AS time FROM kernel_fs_inode WHERE ino = ?",
        )
        .get(inode.toString()),
    ).toMatchObject({ ino: "text", size: "text", time: "text" });
    tick();
    fs.setTimes(inode, {});
    expect(fs.stat(inode)).toMatchObject({
      atimeNs: -12345678901234567890n,
      mtimeNs: 12345678901234567890n,
      ctimeNs: nowNs(),
    });
  });

  it("lists names and inode identities without following symlinks", () => {
    const { fs, file, directory } = fixture();
    const regular = file("z");
    const dir = directory("a");
    const link = fs.create(fs.root, "m", { type: "symlink", exclusive: true, target: "é🎉" });
    expect(fs.readlink(link)).toBe("é🎉");
    expect(fs.stat(link)).toMatchObject({ type: "symlink", size: 6n, nlink: 1n });
    expect(fs.readdir(fs.root)).toEqual([
      { name: "a", inode: dir, type: "directory" },
      { name: "m", inode: link, type: "symlink" },
      { name: "z", inode: regular, type: "file" },
    ]);
    expect(fs.lookup(fs.root, "m")).toBe(link);
    expect(() => fs.readlink(regular)).toThrowError(error("EINVAL"));
    expect(() => fs.lookup(regular, "x")).toThrowError(error("ENOTDIR"));
    expect(() => fs.readdir(regular)).toThrowError(error("ENOTDIR"));
  });

  it("retains nonexclusive existing regular files without truncating them", () => {
    const { fs, file, directory, db } = fixture();
    const inode = file();
    db.prepare("UPDATE kernel_fs_inode SET size = '9223372036854775807' WHERE ino = ?").run(
      inode.toString(),
    );
    expect(fs.create(fs.root, "file", { type: "file", exclusive: false })).toBe(inode);
    expect(fs.stat(inode).size).toBe(9223372036854775807n);
    directory("dir");
    fs.create(fs.root, "link", { type: "symlink", exclusive: true, target: "file" });
    expect(() => file()).toThrowError(error("EEXIST"));
    expect(() => fs.create(fs.root, "dir", { type: "file", exclusive: false })).toThrowError(
      error("EISDIR"),
    );
    expect(() => fs.create(fs.root, "link", { type: "file", exclusive: false })).toThrowError(
      error("ELOOP"),
    );
    expect(() => fs.create(fs.root, "bad", { type: "symlink", exclusive: false })).toThrowError(
      error("EINVAL"),
    );
    expect(() =>
      fs.create(fs.root, "bad", { type: "file", exclusive: false, target: "x" }),
    ).toThrowError(error("EINVAL"));
    fs.unlink(fs.root, "file", { directory: false });
    fs.release(inode);
    expect(fs.stat(inode).nlink).toBe(0n);
    fs.release(inode);
    expect(() => fs.stat(inode)).toThrowError(error("ENOENT"));
  });

  it.each<CreateOptions>([
    { type: "directory", exclusive: false },
    { type: "symlink", exclusive: false, target: "file" },
  ])("rejects nonexclusive $type creation over an existing file", (options) => {
    const { fs, file, directory } = fixture();
    const inode = file();
    directory("dir");
    fs.create(fs.root, "link", { type: "symlink", exclusive: true, target: "file" });
    const before = fs.stat(inode);
    const parentBefore = fs.stat(fs.root);
    expect(() => fs.create(fs.root, "file", options)).toThrowError(error("EEXIST"));
    expect(() => fs.create(fs.root, "dir", options)).toThrowError(error("EISDIR"));
    expect(() => fs.create(fs.root, "link", options)).toThrowError(error("ELOOP"));
    expect(fs.lookup(fs.root, "file")).toBe(inode);
    expect(fs.stat(inode)).toEqual(before);
    expect(fs.stat(fs.root)).toEqual(parentBefore);
    fs.unlink(fs.root, "file", { directory: false });
    fs.release(inode);
    expect(() => fs.stat(inode)).toThrowError(error("ENOENT"));
  });

  it.each(["file", "symlink"])("cannot relink a retained unlinked %s", (type) => {
    const { fs, file } = fixture();
    const inode =
      type === "file"
        ? file()
        : fs.create(fs.root, "file", { type: "symlink", exclusive: true, target: "target" });
    fs.unlink(fs.root, "file", { directory: false });
    const before = fs.stat(inode);
    const parentBefore = fs.stat(fs.root);
    expect(before.nlink).toBe(0n);
    expect(() => fs.link(inode, fs.root, "resurrected")).toThrowError(error("ENOENT"));
    expect(fs.stat(inode)).toEqual(before);
    expect(fs.stat(fs.root)).toEqual(parentBefore);
    expect(fs.readdir(fs.root)).toEqual([]);
    fs.release(inode);
    expect(() => fs.stat(inode)).toThrowError(error("ENOENT"));
  });

  it.each(["", ".", "..", "a/b", "a\0b"])(
    "rejects non-component name %j without changing the namespace",
    (name) => {
      const { fs, file } = fixture();
      const inode = file();
      expect(() => fs.lookup(fs.root, name)).toThrowError(error("EINVAL"));
      expect(() => fs.create(fs.root, name, { type: "file", exclusive: true })).toThrowError(
        error("EINVAL"),
      );
      expect(() => fs.link(inode, fs.root, name)).toThrowError(error("EINVAL"));
      expect(() => fs.unlink(fs.root, name, { directory: false })).toThrowError(error("EINVAL"));
      expect(() => fs.rename(fs.root, "file", fs.root, name)).toThrowError(error("EINVAL"));
      expect(() => fs.rename(fs.root, name, fs.root, "other")).toThrowError(error("EINVAL"));
      expect(fs.lookup(fs.root, "file")).toBe(inode);
      expect(fs.readdir(fs.root)).toHaveLength(1);
    },
  );

  it("rejects mutations through an unlinked retained directory", () => {
    const { fs, file, directory } = fixture();
    const dir = directory("dir");
    const inode = file();
    fs.unlink(fs.root, "dir", { directory: true });
    expect(fs.stat(dir).nlink).toBe(0n);
    expect(fs.readdir(dir)).toEqual([]);
    expect(() => file("x", dir)).toThrowError(error("ENOENT"));
    expect(() => fs.link(inode, dir, "x")).toThrowError(error("ENOENT"));
    expect(() => fs.unlink(dir, "x", { directory: false })).toThrowError(error("ENOENT"));
    expect(() => fs.rename(fs.root, "file", dir, "x")).toThrowError(error("ENOENT"));
    expect(() => fs.rename(dir, "x", fs.root, "x")).toThrowError(error("ENOENT"));
    expect(() => file("x", inode)).toThrowError(error("ENOTDIR"));
    expect(() => fs.link(fs.root, fs.root, "root-link")).toThrowError(error("EPERM"));
  });

  it("counts file links and directory children, stamping only affected metadata", () => {
    const { fs, file, directory, tick, nowNs } = fixture();
    const inode = file();
    const original = fs.stat(inode);
    tick();
    fs.link(inode, fs.root, "alias");
    expect(fs.stat(inode)).toEqual({ ...original, nlink: 2n, ctimeNs: nowNs() });
    fs.unlink(fs.root, "alias", { directory: false });
    expect(fs.stat(inode).nlink).toBe(1n);
    const a = directory("a");
    const b = directory("b", a);
    expect(fs.stat(fs.root).nlink).toBe(3n);
    expect(fs.stat(a).nlink).toBe(3n);
    expect(fs.stat(b).nlink).toBe(2n);
    expect(() => fs.unlink(fs.root, "a", { directory: true })).toThrowError(error("ENOTEMPTY"));
    expect(() => fs.unlink(a, "b", { directory: false })).toThrowError(error("EISDIR"));
    expect(() => fs.unlink(fs.root, "file", { directory: true })).toThrowError(error("ENOTDIR"));
    fs.unlink(a, "b", { directory: true });
    fs.unlink(fs.root, "a", { directory: true });
    expect(fs.stat(fs.root).nlink).toBe(2n);
  });

  it("keeps pinned file chunks after unlink and destroys them on final release", () => {
    const { fs, file, storage, db } = fixture();
    const inode = file();
    storage.sql.exec(
      "INSERT INTO kernel_fs_chunk VALUES (?, 0, ?)",
      inode.toString(),
      new Uint8Array([1, 2, 3]).buffer,
    );
    fs.retain(inode);
    fs.unlink(fs.root, "file", { directory: false });
    expect(fs.stat(inode).nlink).toBe(0n);
    expect(() => fs.lookup(fs.root, "file")).toThrowError(error("ENOENT"));
    fs.release(inode);
    expect(db.prepare("SELECT * FROM kernel_fs_chunk").all()).toHaveLength(1);
    fs.release(inode);
    expect(db.prepare("SELECT * FROM kernel_fs_chunk").all()).toHaveLength(0);
    expect(() => fs.stat(inode)).toThrowError(error("ENOENT"));
  });

  it("validates pins and leaves them unchanged when commit fails", () => {
    const { fs, file, rejectCommit } = fixture();
    expect(() => fs.retain(123n)).toThrowError(error("ENOENT"));
    expect(() => fs.release(123n)).toThrowError(error("EINVAL"));
    const inode = file();
    rejectCommit();
    expect(() => fs.retain(inode)).toThrow("commit failed");
    fs.unlink(fs.root, "file", { directory: false });
    rejectCommit();
    expect(() => fs.release(inode)).toThrow("commit failed");
    expect(fs.stat(inode).nlink).toBe(0n);
    fs.release(inode);
    expect(() => fs.release(inode)).toThrowError(error("EINVAL"));
    const linked = file("linked");
    fs.release(linked);
    expect(() => fs.release(linked)).toThrowError(error("EINVAL"));
  });

  it("reclaims unlinked inodes without sweeping corrupt chunks or resetting inode IDs", () => {
    const { fs, file, storage, db, nowNs } = fixture();
    const orphan = file("orphan");
    const kept = file("kept");
    fs.unlink(fs.root, "orphan", { directory: false });
    storage.sql.exec(
      "INSERT INTO kernel_fs_chunk VALUES (?, 0, ?)",
      orphan.toString(),
      new Uint8Array([1]).buffer,
    );
    storage.sql.exec(
      "INSERT INTO kernel_fs_chunk VALUES ('999', 0, ?)",
      new Uint8Array([1]).buffer,
    );
    storage.sql.exec(
      "INSERT INTO kernel_fs_chunk VALUES (?, 0, ?)",
      kept.toString(),
      new Uint8Array([1]).buffer,
    );
    const reopened = createFacetSqliteStorage(storage, nowNs);
    expect(() => reopened.stat(orphan)).toThrowError(error("ENOENT"));
    expect(reopened.lookup(reopened.root, "kept")).toBe(kept);
    expect(db.prepare("SELECT ino FROM kernel_fs_chunk ORDER BY ino").all()).toEqual([
      { ino: kept.toString() },
      { ino: "999" },
    ]);
    const huge = 900719925474099300001n;
    db.prepare("UPDATE kernel_fs_meta SET v = ? WHERE k = 'next_inode'").run(huge.toString());
    expect(reopened.create(reopened.root, "huge", { type: "file", exclusive: true })).toBe(huge);
    expect(
      createFacetSqliteStorage(storage, nowNs).create(fs.root, "next", {
        type: "file",
        exclusive: true,
      }),
    ).toBe(huge + 1n);
  });

  it("fails unknown schemas without dropping or rewriting stored rows", () => {
    const { db, file, storage, nowNs } = fixture();
    const inode = file();
    db.prepare("UPDATE kernel_fs_meta SET v = '2' WHERE k = 'schema'").run();
    expect(() => createFacetSqliteStorage(storage, nowNs)).toThrow(
      "Unsupported kernel filesystem schema",
    );
    expect(db.prepare("SELECT v FROM kernel_fs_meta WHERE k = 'schema'").get()).toMatchObject({
      v: "2",
    });
    expect(
      db.prepare("SELECT ino FROM kernel_fs_inode WHERE ino = ?").get(inode.toString()),
    ).toMatchObject({ ino: inode.toString() });
  });

  it("moves directory subtrees with correct parent links and timestamps", () => {
    const { fs, directory, file, tick, nowNs } = fixture();
    const a = directory("a");
    const b = directory("b");
    const child = directory("child", a);
    const leaf = file("leaf", child);
    tick();
    fs.rename(a, "child", b, "moved");
    expect(() => fs.lookup(a, "child")).toThrowError(error("ENOENT"));
    expect(fs.lookup(b, "moved")).toBe(child);
    expect(fs.lookup(child, "leaf")).toBe(leaf);
    expect(fs.stat(a)).toMatchObject({ nlink: 2n, mtimeNs: nowNs(), ctimeNs: nowNs() });
    expect(fs.stat(b)).toMatchObject({ nlink: 3n, mtimeNs: nowNs(), ctimeNs: nowNs() });
    expect(fs.stat(child)).toMatchObject({ nlink: 2n, ctimeNs: nowNs() });
  });

  it("replaces pinned destinations, preserving their lifetime and chunks", () => {
    const { fs, file, storage, db } = fixture();
    const source = file("source");
    const destination = file("destination");
    storage.sql.exec(
      "INSERT INTO kernel_fs_chunk VALUES (?, 0, ?)",
      destination.toString(),
      new Uint8Array([7]).buffer,
    );
    fs.rename(fs.root, "source", fs.root, "destination");
    expect(fs.lookup(fs.root, "destination")).toBe(source);
    expect(fs.stat(source).nlink).toBe(1n);
    expect(fs.stat(destination).nlink).toBe(0n);
    expect(db.prepare("SELECT * FROM kernel_fs_chunk").all()).toHaveLength(1);
    fs.release(destination);
    expect(db.prepare("SELECT * FROM kernel_fs_chunk").all()).toHaveLength(0);
  });

  it("treats renaming aliases of the same inode as a complete no-op", () => {
    const { fs, file, tick } = fixture();
    const inode = file();
    fs.link(inode, fs.root, "alias");
    const parentBefore = fs.stat(fs.root);
    const before = fs.stat(inode);
    tick();
    fs.rename(fs.root, "file", fs.root, "alias");
    expect(fs.lookup(fs.root, "file")).toBe(inode);
    expect(fs.lookup(fs.root, "alias")).toBe(inode);
    expect(fs.stat(inode)).toEqual(before);
    expect(fs.stat(fs.root)).toEqual(parentBefore);
  });

  it("rejects cycles and incompatible replacements without partial mutations", () => {
    const { fs, directory, file } = fixture();
    const a = directory("a");
    const child = directory("child", a);
    directory("nonempty");
    file("leaf", fs.lookup(fs.root, "nonempty"));
    const regular = file();
    expect(() => fs.rename(fs.root, "a", child, "cycle")).toThrowError(error("EINVAL"));
    expect(() => fs.rename(fs.root, "a", a, "cycle")).toThrowError(error("EINVAL"));
    expect(() => fs.rename(fs.root, "a", fs.root, "nonempty")).toThrowError(error("ENOTEMPTY"));
    expect(() => fs.rename(fs.root, "a", fs.root, "file")).toThrowError(error("ENOTDIR"));
    expect(() => fs.rename(fs.root, "file", fs.root, "a")).toThrowError(error("EISDIR"));
    expect(fs.lookup(fs.root, "a")).toBe(a);
    expect(fs.lookup(a, "child")).toBe(child);
    expect(fs.lookup(fs.root, "file")).toBe(regular);
  });

  it("replaces an empty directory while keeping directory link counts exact", () => {
    const { fs, directory } = fixture();
    const a = directory("a");
    const b = directory("b");
    const moved = directory("moved", a);
    const replaced = directory("replaced", b);
    fs.rename(a, "moved", b, "replaced");
    expect(fs.stat(a).nlink).toBe(2n);
    expect(fs.stat(b).nlink).toBe(3n);
    expect(fs.stat(moved).nlink).toBe(2n);
    expect(fs.stat(replaced).nlink).toBe(0n);
    const second = directory("second", b);
    fs.rename(b, "replaced", b, "second");
    expect(fs.stat(b).nlink).toBe(3n);
    expect(fs.stat(second).nlink).toBe(0n);
  });

  it("rolls back namespace, metadata, counters, and create pins on failed commits", () => {
    const { fs, file, directory, db, rejectCommit } = fixture();
    const inode = file();
    const dir = directory("dir");
    const snapshot = () =>
      ["kernel_fs_inode", "kernel_fs_entry", "kernel_fs_meta"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
      );
    const before = snapshot();
    const mutations = [
      () => file("new"),
      () => fs.create(fs.root, "file", { type: "file", exclusive: false }),
      () => fs.link(inode, fs.root, "alias"),
      () => fs.unlink(fs.root, "file", { directory: false }),
      () => fs.rename(fs.root, "file", dir, "renamed"),
      () => fs.setTimes(inode, { atimeNs: 123n }),
    ];
    for (const mutate of mutations) {
      rejectCommit();
      expect(mutate).toThrow("commit failed");
      expect(snapshot()).toEqual(before);
    }
    fs.unlink(fs.root, "file", { directory: false });
    fs.release(inode);
    expect(() => fs.stat(inode)).toThrowError(error("ENOENT"));
    const next = file("new");
    fs.unlink(fs.root, "new", { directory: false });
    fs.release(next);
    expect(() => fs.stat(next)).toThrowError(error("ENOENT"));
  });
});
