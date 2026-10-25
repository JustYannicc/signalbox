import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage, type FacetStorage } from "./FacetSqliteStorage.ts";
import { runPosixStorageProof, readPosixStorageProof } from "./PosixStorageProof.ts";

const databases: NodeSqlite.DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const fixture = () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  databases.push(db);
  let now = 900719925474099312345n;
  let reject = false;
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
    transactionSync(callback) {
      db.exec("BEGIN");
      try {
        const result = callback();
        if (reject) {
          reject = false;
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
  const open = () => createFacetSqliteStorage(storage, () => now);
  const fs = open();
  const metadata = { mode: 0o6754, uid: 1001, gid: 1002 };
  const file = (name = "file") =>
    fs.posix.create(fs.root, name, { type: "file", exclusive: true, metadata });
  return {
    db,
    fs,
    open,
    file,
    metadata,
    tick: () => ++now,
    rejectCommit: () => {
      reject = true;
    },
  };
};
const errno = (code: string) => expect.objectContaining({ code });

describe("persisted POSIX inode metadata", () => {
  it("passes the same runtime proof repeatedly across fresh backend wrappers", () => {
    const { fs, open } = fixture();
    expect(runPosixStorageProof(fs).ok).toBe(true);
    expect(readPosixStorageProof(open()).ok).toBe(true);
    expect(runPosixStorageProof(open()).ok).toBe(true);
    expect(readPosixStorageProof(open()).ok).toBe(true);
  });

  it("requires explicit root and legacy metadata without changing canonical stat", () => {
    const { fs, metadata, open } = fixture();
    expect(() => fs.posix.get(fs.root)).toThrowError(errno("ENOTSUP"));
    fs.posix.initialize(fs.root, { ...metadata, mode: 0o755 });
    expect(fs.posix.get(fs.root)).toEqual({ ...metadata, mode: 0o755 });
    expect(() => fs.posix.initialize(fs.root, metadata)).toThrowError(errno("EEXIST"));
    const legacy = fs.create(fs.root, "legacy", { type: "file", exclusive: true });
    expect(() => fs.posix.get(legacy)).toThrowError(errno("ENOTSUP"));
    expect(() => fs.posix.chmod(legacy, 0o600)).toThrowError(errno("ENOTSUP"));
    expect(() => fs.posix.chown(legacy, { uid: 1, gid: 2 })).toThrowError(errno("ENOTSUP"));
    fs.posix.initialize(legacy, metadata);
    fs.release(legacy);
    expect(open().posix.get(legacy)).toEqual(metadata);
    expect(fs.stat(legacy)).not.toHaveProperty("uid");
    expect(() => fs.posix.get(999n)).toThrowError(errno("ENOENT"));
  });

  it("persists chmod/chown and only changes ctime, preserving contents and file type", () => {
    const { fs, metadata, file, tick, open } = fixture();
    const inode = file();
    fs.write(inode, 0n, new Uint8Array([3, 1, 4]));
    const before = fs.stat(inode);
    const ctimeNs = tick();
    fs.posix.chmod(inode, 0o7777);
    expect(fs.posix.get(inode)).toEqual({ ...metadata, mode: 0o7777 });
    expect(fs.stat(inode)).toEqual({ ...before, ctimeNs });
    tick();
    fs.posix.chown(inode, { uid: 0xffff_fffe, gid: 0x8000_0000 });
    expect(fs.posix.get(inode)).toEqual({ mode: 0o1777, uid: 0xffff_fffe, gid: 0x8000_0000 });
    fs.release(inode);
    const reopened = open();
    expect(reopened.posix.get(inode)).toEqual(fs.posix.get(inode));
    expect(reopened.stat(inode)).toMatchObject({
      type: "file",
      atimeNs: before.atimeNs,
      mtimeNs: before.mtimeNs,
    });
    const bytes = new Uint8Array(3);
    expect(reopened.readInto(inode, 0n, bytes)).toBe(3);
    expect([...bytes]).toEqual([3, 1, 4]);
  });

  it("uses the canonical inode through hard links, rename and retained unlink", () => {
    const { fs, file, db } = fixture();
    const inode = file();
    fs.link(inode, fs.root, "alias");
    fs.rename(fs.root, "alias", fs.root, "renamed");
    fs.posix.chmod(fs.lookup(fs.root, "renamed"), 0o600);
    expect(fs.posix.get(fs.lookup(fs.root, "file")).mode).toBe(0o600);
    fs.unlink(fs.root, "file", { directory: false });
    fs.unlink(fs.root, "renamed", { directory: false });
    fs.posix.chown(inode, { uid: 4, gid: 5 });
    expect(fs.posix.get(inode)).toEqual({ mode: 0o600, uid: 4, gid: 5 });
    fs.release(inode);
    expect(() => fs.posix.get(inode)).toThrowError(errno("ENOENT"));
    expect(db.prepare("SELECT ino FROM kernel_fs_posix").all()).toEqual([]);
  });

  it("keeps symlink metadata separate from its target and directory setgid intact", () => {
    const { fs, file, metadata } = fixture();
    const target = file();
    const link = fs.posix.create(fs.root, "link", {
      type: "symlink",
      exclusive: true,
      target: "file",
      metadata: { ...metadata, mode: 0o777 },
    });
    fs.posix.chown(link, { uid: 7, gid: 8 });
    expect(fs.posix.get(target)).toEqual(metadata);
    expect(fs.posix.get(link)).toEqual({ mode: 0o777, uid: 7, gid: 8 });
    const dir = fs.posix.create(fs.root, "dir", { type: "directory", exclusive: true, metadata });
    fs.posix.chown(dir, { uid: 7, gid: 8 });
    expect(fs.posix.get(dir).mode).toBe(metadata.mode);
  });

  it("does not apply creation policy to an existing file or unknown legacy row", () => {
    const { fs, file, metadata } = fixture();
    const inode = file();
    const opts = { type: "file", exclusive: false, metadata: { mode: 0, uid: 0, gid: 0 } } as const;
    expect(fs.posix.create(fs.root, "file", opts)).toBe(inode);
    expect(fs.posix.get(inode)).toEqual(metadata);
    const legacy = fs.create(fs.root, "old", { type: "file", exclusive: true });
    expect(fs.posix.create(fs.root, "old", opts)).toBe(legacy);
    expect(() => fs.posix.get(legacy)).toThrowError(errno("ENOTSUP"));
    fs.unlink(fs.root, "file", { directory: false });
    fs.release(inode);
    expect(fs.posix.get(inode)).toEqual(metadata);
    fs.release(inode);
    expect(() => fs.stat(inode)).toThrowError(errno("ENOENT"));
  });

  it("rolls back inode, metadata, namespace and pin publication on failure", () => {
    const { fs, file, db, rejectCommit, metadata } = fixture();
    rejectCommit();
    expect(() => file()).toThrow("commit failed");
    expect(() => fs.lookup(fs.root, "file")).toThrowError(errno("ENOENT"));
    expect(db.prepare("SELECT ino FROM kernel_fs_posix").all()).toEqual([]);
    expect(() => fs.release(2n)).toThrowError(errno("EINVAL"));
    const inode = file();
    expect(inode).toBe(2n);
    const before = fs.stat(inode);
    rejectCommit();
    expect(() => fs.posix.chmod(inode, 0o600)).toThrow("commit failed");
    expect(fs.posix.get(inode)).toEqual(metadata);
    expect(fs.stat(inode)).toEqual(before);
    rejectCommit();
    expect(() => fs.posix.chown(inode, { uid: 8, gid: 9 })).toThrow("commit failed");
    expect(fs.posix.get(inode)).toEqual(metadata);
    fs.unlink(fs.root, "file", { directory: false });
    fs.release(inode);
    expect(() => fs.stat(inode)).toThrowError(errno("ENOENT"));
  });

  it("rejects invalid modes and preserve sentinels without partial mutations", () => {
    const { fs, file, metadata } = fixture();
    const inode = file();
    for (const mode of [-1, 0o10000, 1.5, NaN, Infinity]) {
      expect(() => fs.posix.chmod(inode, mode)).toThrowError(errno("EINVAL"));
      expect(() =>
        fs.posix.create(fs.root, "bad", {
          type: "file",
          exclusive: true,
          metadata: { ...metadata, mode },
        }),
      ).toThrowError(errno("EINVAL"));
    }
    for (const id of [-1, 0xffff_ffff, 0x1_0000_0000, 0.5, NaN]) {
      expect(() => fs.posix.chown(inode, { uid: id, gid: 0 })).toThrowError(errno("EINVAL"));
      expect(() => fs.posix.chown(inode, { uid: 0, gid: id })).toThrowError(errno("EINVAL"));
    }
    expect(fs.posix.get(inode)).toEqual(metadata);
    expect(() => fs.lookup(fs.root, "bad")).toThrowError(errno("ENOENT"));
  });

  it("reclaims metadata with orphaned inodes on a new incarnation", () => {
    const { fs, file, open, db } = fixture();
    const inode = file();
    fs.unlink(fs.root, "file", { directory: false });
    expect(fs.posix.get(inode).uid).toBe(1001);
    const restarted = open();
    expect(() => restarted.posix.get(inode)).toThrowError(errno("ENOENT"));
    expect(db.prepare("SELECT ino FROM kernel_fs_posix").all()).toEqual([]);
  });
});
