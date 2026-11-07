import type { KernelStorageSnapshot } from "../KernelStorageSnapshot.ts";
import type { Inode } from "../storage.ts";
import { type FacetStorage, StorageError } from "./SqliteDatabase.ts";
import { fileType, statFromRow, validName } from "./SqliteInodes.ts";
import { posixFromRow } from "./SqlitePosixMetadata.ts";

const readOnly = () => {
  throw new StorageError("EROFS");
};

/**
 * Computer's storage in four queries: every inode with its owner, every name, and the overlay's
 * whiteouts and staged files. Reads check rows as the live ones do, when asked, so a damaged row
 * fails the path that reaches it rather than the whole snapshot.
 */
export function readSqliteSnapshot(
  storage: FacetStorage,
  maxEntries: number,
): KernelStorageSnapshot {
  // One transaction, so names, inodes and the overlay's records are read at the same instant.
  const { inodes, names, hidden, staging } = storage.transactionSync(() => {
    const inodes = new Map<Inode, Record<string, unknown>>();
    for (const row of storage.sql.exec(
      "SELECT i.*, p.mode, p.uid, p.gid FROM kernel_fs_inode i LEFT JOIN kernel_fs_posix p ON p.ino = i.ino",
    ))
      inodes.set(BigInt(String(row.ino)), row);
    const names = new Map<Inode, Map<string, Inode>>();
    let entries = 0;
    // The entry key orders each directory's names as `readdir` does.
    for (const row of storage.sql.exec(
      "SELECT parent, name, ino FROM kernel_fs_entry ORDER BY parent, name",
    )) {
      if (++entries > maxEntries) throw new StorageError("E2BIG");
      const parent = BigInt(String(row.parent));
      let children = names.get(parent);
      if (children === undefined) names.set(parent, (children = new Map()));
      children.set(String(row.name), BigInt(String(row.ino)));
    }
    const paths = (query: string) =>
      new Set(Array.from(storage.sql.exec(query), (row) => String(row.path)));
    return {
      inodes,
      names,
      hidden: paths("SELECT path FROM kernel_fs_overlay_whiteout"),
      staging: paths("SELECT path FROM kernel_fs_overlay_staging"),
    };
  });
  const row = (inode: Inode) => {
    const found = inodes.get(inode);
    if (found === undefined) throw new StorageError("ENOENT");
    return found;
  };
  const stat = (inode: Inode) => statFromRow(row(inode));
  const directory = (inode: Inode) => {
    if (stat(inode).type !== "directory") throw new StorageError("ENOTDIR");
  };
  return {
    immutable: true,
    root: 1n,
    lookup(parent, name) {
      validName(name);
      directory(parent);
      const inode = names.get(parent)?.get(name);
      if (inode === undefined) throw new StorageError("ENOENT");
      return inode;
    },
    stat,
    readlink(inode) {
      const found = row(inode);
      if (found.type !== "symlink") throw new StorageError("EINVAL");
      return String(found.target);
    },
    readdir(inode) {
      directory(inode);
      // A name whose inode row is gone is left out, as `readdir`'s join leaves it out.
      return Array.from(names.get(inode) ?? []).flatMap(([name, child]) => {
        const found = inodes.get(child);
        return found === undefined ? [] : [{ name, inode: child, type: fileType(found.type) }];
      });
    },
    posix: {
      get(inode) {
        stat(inode);
        return posixFromRow(row(inode));
      },
      initialize: readOnly,
      create: readOnly,
      chmod: readOnly,
      chown: readOnly,
    },
    lowerOverlay: {
      isLowerPathHidden: (path) => hidden.has(path),
      isStagingPath: (path) => staging.has(path),
      createStagingFile: readOnly,
      publishStagingFile: readOnly,
      discardStagingFile: readOnly,
      renameFileWithWhiteout: readOnly,
      unlinkFileWithWhiteout: readOnly,
    },
    retain: readOnly,
    release: readOnly,
    readInto: readOnly,
    write: readOnly,
    append: readOnly,
    truncate: readOnly,
    setTimes: readOnly,
    sync: readOnly,
    create: readOnly,
    link: readOnly,
    unlink: readOnly,
    rename: readOnly,
  };
}
