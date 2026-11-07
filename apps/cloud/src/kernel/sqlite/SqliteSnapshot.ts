import { isPosixMetadata } from "../PosixStorage.ts";
import type { KernelStorageSnapshot } from "../KernelStorageSnapshot.ts";
import type { Inode, Stat } from "../storage.ts";
import { type FacetStorage, StorageError } from "./SqliteDatabase.ts";

const COLUMNS =
  "i.ino, i.type, i.size, i.nlink, i.atime_ns, i.mtime_ns, i.ctime_ns, i.target, p.mode, p.uid, p.gid";

/**
 * Computer's whole tree in four queries: the root, every name joined to its inode and owner, and
 * the overlay's records. Rows are checked as `stat`, `readdir` and `posix.get` check them, when
 * asked, so a damaged row fails the path that reaches it rather than the whole snapshot.
 */
export function readSqliteSnapshot(
  storage: FacetStorage,
  maxEntries: number,
): KernelStorageSnapshot {
  const inodes = new Map<Inode, Record<string, unknown>>();
  const names = new Map<Inode, Map<string, Inode>>();
  for (const row of storage.sql.exec(
    `SELECT ${COLUMNS} FROM kernel_fs_inode i LEFT JOIN kernel_fs_posix p ON p.ino = i.ino WHERE i.ino = '1'`,
  ))
    inodes.set(1n, row);
  let entries = 0;
  // The entry key orders each directory's names as `readdir` does.
  for (const row of storage.sql.exec(
    `SELECT e.parent, e.name, ${COLUMNS} FROM kernel_fs_entry e JOIN kernel_fs_inode i ON i.ino = e.ino LEFT JOIN kernel_fs_posix p ON p.ino = e.ino ORDER BY e.parent, e.name`,
  )) {
    if (++entries > maxEntries) throw new StorageError("E2BIG");
    const inode = BigInt(String(row.ino));
    inodes.set(inode, row);
    const parent = BigInt(String(row.parent));
    let children = names.get(parent);
    if (children === undefined) names.set(parent, (children = new Map()));
    children.set(String(row.name), inode);
  }
  const paths = (query: string) =>
    new Set(Array.from(storage.sql.exec(query), (row) => String(row.path)));
  const hidden = paths("SELECT path FROM kernel_fs_overlay_whiteout");
  const staging = paths("SELECT path FROM kernel_fs_overlay_staging");
  const fileType = (inode: Inode) => {
    const type = inodes.get(inode)?.type;
    if (type !== "file" && type !== "directory" && type !== "symlink")
      throw new StorageError("EIO");
    return type;
  };
  return {
    children: (directory) =>
      Array.from(names.get(directory) ?? [], ([name, inode]) => ({
        name,
        inode,
        type: fileType(inode),
      })),
    lookup: (directory, name) => names.get(directory)?.get(name),
    stat(inode): Stat | undefined {
      const row = inodes.get(inode);
      if (row === undefined) return undefined;
      const nlink = Number(row.nlink);
      if (!Number.isSafeInteger(nlink) || nlink < 0) throw new StorageError("EIO");
      return {
        type: fileType(inode),
        size: BigInt(String(row.size)),
        nlink: BigInt(nlink),
        atimeNs: BigInt(String(row.atime_ns)),
        mtimeNs: BigInt(String(row.mtime_ns)),
        ctimeNs: BigInt(String(row.ctime_ns)),
      };
    },
    readlink(inode) {
      const row = inodes.get(inode);
      if (row === undefined) throw new StorageError("ENOENT");
      if (row.type !== "symlink") throw new StorageError("EINVAL");
      return String(row.target);
    },
    posix(inode) {
      const row = inodes.get(inode);
      if (row === undefined || row.mode === null || row.mode === undefined) return undefined;
      const metadata = { mode: row.mode, uid: row.uid, gid: row.gid };
      if (!isPosixMetadata(metadata)) throw new StorageError("EIO");
      return metadata;
    },
    isLowerPathHidden: (path) => hidden.has(path),
    isStagingPath: (path) => staging.has(path),
  };
}
