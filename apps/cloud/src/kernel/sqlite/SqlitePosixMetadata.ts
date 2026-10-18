import { isPosixMetadata, type PosixMetadata, type PosixStorage } from "../PosixStorage.ts";
import type { Inode } from "../storage.ts";
import { firstRow, StorageError } from "./SqliteDatabase.ts";
import type { SqliteInodes } from "./SqliteInodes.ts";

export class SqlitePosixMetadata {
  private readonly inodes: SqliteInodes;

  constructor(inodes: SqliteInodes) {
    this.inodes = inodes;
  }

  get(inode: Inode): PosixMetadata {
    this.inodes.stat(inode);
    const row = firstRow(
      this.inodes.storage.sql.exec(
        "SELECT mode, uid, gid FROM kernel_fs_posix WHERE ino = ?",
        inode.toString(),
      ),
    );
    if (!row) throw new StorageError("ENOTSUP");
    if (!isPosixMetadata(row)) throw new StorageError("EIO");
    return { mode: row.mode, uid: row.uid, gid: row.gid };
  }

  initialize(inode: Inode, metadata: PosixMetadata): void {
    this.validate(metadata);
    this.inodes.storage.transactionSync(() => {
      this.inodes.stat(inode);
      const row = firstRow(
        this.inodes.storage.sql.exec(
          "SELECT ino FROM kernel_fs_posix WHERE ino = ?",
          inode.toString(),
        ),
      );
      if (row) throw new StorageError("EEXIST");
      this.insert(inode, metadata);
      this.touch(inode);
    });
  }

  create: PosixStorage["posix"]["create"] = (parent, name, options) => {
    this.validate(options.metadata);
    return this.inodes.create(parent, name, options, (inode) =>
      this.insert(inode, options.metadata),
    );
  };

  chmod(inode: Inode, mode: number): void {
    // Validate before mutation; masking belongs to the guest ABI adapter.
    this.validate({ mode, uid: 0, gid: 0 });
    this.inodes.storage.transactionSync(() => {
      this.get(inode);
      this.inodes.storage.sql.exec(
        "UPDATE kernel_fs_posix SET mode = ? WHERE ino = ?",
        mode,
        inode.toString(),
      );
      this.touch(inode);
    });
  }

  chown(inode: Inode, owner: Pick<PosixMetadata, "uid" | "gid">): void {
    this.validate({ mode: 0, ...owner });
    this.inodes.storage.transactionSync(() => {
      const previous = this.get(inode);
      const changed = previous.uid !== owner.uid || previous.gid !== owner.gid;
      const mode =
        changed && this.inodes.stat(inode).type === "file"
          ? previous.mode & ~0o6000
          : previous.mode;
      this.inodes.storage.sql.exec(
        "UPDATE kernel_fs_posix SET mode = ?, uid = ?, gid = ? WHERE ino = ?",
        mode,
        owner.uid,
        owner.gid,
        inode.toString(),
      );
      this.touch(inode);
    });
  }

  private validate(metadata: PosixMetadata): void {
    if (!isPosixMetadata(metadata)) throw new StorageError("EINVAL");
  }

  private insert(inode: Inode, metadata: PosixMetadata): void {
    this.inodes.storage.sql.exec(
      "INSERT INTO kernel_fs_posix (ino, mode, uid, gid) VALUES (?, ?, ?, ?)",
      inode.toString(),
      metadata.mode,
      metadata.uid,
      metadata.gid,
    );
  }

  private touch(inode: Inode): void {
    this.inodes.storage.sql.exec(
      "UPDATE kernel_fs_inode SET ctime_ns = ? WHERE ino = ?",
      this.inodes.nowNs().toString(),
      inode.toString(),
    );
  }
}
