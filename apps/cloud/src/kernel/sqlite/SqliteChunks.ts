import type { Inode } from "../storage.ts";
import { fileSize, firstRow, StorageError } from "./SqliteDatabase.ts";
import type { SqliteInodes } from "./SqliteInodes.ts";

export const FILE_CHUNK_BYTES = 64 * 1024;
const CHUNK = BigInt(FILE_CHUNK_BYTES);
const chunkBytes = (value: unknown) => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new Error("Invalid filesystem chunk");
};

// Adapted from Nimbus's resident cells/tables: metadata is separate from bounded chunks.
// Sparse offsets stay bigint; each chunk index fits exactly in SQLite's numeric binding.
export class SqliteChunks {
  private readonly inodes: SqliteInodes;
  constructor(inodes: SqliteInodes) {
    this.inodes = inodes;
  }

  readInto(inode: Inode, offset: bigint, target: Uint8Array) {
    fileSize(offset);
    const stat = this.file(inode);
    const remaining = stat.size > offset ? stat.size - offset : 0n;
    const length = Number(
      remaining < BigInt(target.byteLength) ? remaining : BigInt(target.byteLength),
    );
    target.fill(0, 0, length);
    let done = 0;
    while (done < length) {
      const position = offset + BigInt(done);
      const within = Number(position % CHUNK);
      const count = Math.min(length - done, FILE_CHUNK_BYTES - within);
      const row = firstRow(
        this.inodes.storage.sql.exec(
          "SELECT bin FROM kernel_fs_chunk WHERE ino = ? AND part = ?",
          inode.toString(),
          Number(position / CHUNK),
        ),
      );
      if (row) target.set(chunkBytes(row.bin).subarray(within, within + count), done);
      done += count;
    }
    return length;
  }

  write(inode: Inode, offset: bigint, source: Uint8Array) {
    fileSize(offset);
    fileSize(offset + BigInt(source.byteLength));
    return this.inodes.storage.transactionSync(() => {
      const stat = this.file(inode);
      if (source.byteLength === 0) return 0;
      let done = 0;
      while (done < source.byteLength) {
        const position = offset + BigInt(done);
        const part = Number(position / CHUNK);
        const within = Number(position % CHUNK);
        const count = Math.min(source.byteLength - done, FILE_CHUNK_BYTES - within);
        let existing: Uint8Array | undefined;
        if (within !== 0 || count !== FILE_CHUNK_BYTES) {
          const row = firstRow(
            this.inodes.storage.sql.exec(
              "SELECT bin FROM kernel_fs_chunk WHERE ino = ? AND part = ?",
              inode.toString(),
              part,
            ),
          );
          if (row) existing = chunkBytes(row.bin);
        }
        const chunk = new Uint8Array(Math.max(existing?.byteLength ?? 0, within + count));
        if (existing) chunk.set(existing);
        chunk.set(source.subarray(done, done + count), within);
        this.inodes.storage.sql.exec(
          "INSERT OR REPLACE INTO kernel_fs_chunk (ino, part, bin) VALUES (?, ?, ?)",
          inode.toString(),
          part,
          chunk.buffer,
        );
        done += count;
      }
      const end = offset + BigInt(done);
      this.resize(inode, stat.size > end ? stat.size : end);
      return done;
    });
  }

  append(inode: Inode, source: Uint8Array) {
    return this.inodes.storage.transactionSync(() => {
      const offset = this.file(inode).size;
      return { offset, bytesWritten: this.write(inode, offset, source) };
    });
  }

  truncate(inode: Inode, size: bigint) {
    fileSize(size);
    this.inodes.storage.transactionSync(() => {
      const stat = this.file(inode);
      if (size < stat.size) {
        this.inodes.storage.sql.exec(
          "DELETE FROM kernel_fs_chunk WHERE ino = ? AND part >= ?",
          inode.toString(),
          Number((size + CHUNK - 1n) / CHUNK),
        );
        if (size % CHUNK !== 0n) {
          const part = Number(size / CHUNK);
          const row = firstRow(
            this.inodes.storage.sql.exec(
              "SELECT bin FROM kernel_fs_chunk WHERE ino = ? AND part = ?",
              inode.toString(),
              part,
            ),
          );
          if (row) {
            const chunk = chunkBytes(row.bin).slice(0, Number(size % CHUNK));
            this.inodes.storage.sql.exec(
              "UPDATE kernel_fs_chunk SET bin = ? WHERE ino = ? AND part = ?",
              chunk.buffer,
              inode.toString(),
              part,
            );
          }
        }
      }
      this.resize(inode, size);
    });
  }

  private resize(inode: Inode, size: bigint) {
    const now = this.inodes.nowNs().toString();
    this.inodes.storage.sql.exec(
      "UPDATE kernel_fs_inode SET size = ?, mtime_ns = ?, ctime_ns = ? WHERE ino = ?",
      size.toString(),
      now,
      now,
      inode.toString(),
    );
  }
  private file(inode: Inode) {
    const stat = this.inodes.stat(inode);
    if (stat.type !== "file")
      throw new StorageError(stat.type === "directory" ? "EISDIR" : "EINVAL");
    return stat;
  }
}
