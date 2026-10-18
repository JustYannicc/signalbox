import type { ForkCommit } from "../FilePersistencePorts.ts";
import type { Inode } from "../storage.ts";
import { FILE_CHUNK_BYTES } from "./SqliteChunks.ts";
import { type FacetStorage, firstRow, StorageError } from "./SqliteDatabase.ts";

export interface PendingFile {
  readonly inode: Inode;
  readonly path: string;
  readonly at: ForkCommit;
  readonly size: bigint;
}

type Staging = { readonly file: PendingFile; received: bigint };
const CHUNK = BigInt(FILE_CHUNK_BYTES);

/** Fetches never change visible chunks or file metadata before the final transaction. */
export class SqliteHydration {
  readonly #database: FacetStorage;
  readonly #staging = new Map<Inode, Staging>();

  constructor(database: FacetStorage) {
    this.#database = database;
    database.transactionSync(() => {
      database.sql.exec(`CREATE TABLE IF NOT EXISTS kernel_fs_origin (
        ino TEXT PRIMARY KEY, path TEXT NOT NULL, repository TEXT NOT NULL,
        fork TEXT NOT NULL, source_commit TEXT NOT NULL, size TEXT NOT NULL)`);
      database.sql.exec(`CREATE TABLE IF NOT EXISTS kernel_fs_hydration_chunk (
        ino TEXT NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, PRIMARY KEY (ino, part))`);
      // No asynchronous fetch survives the facet incarnation that staged it.
      database.sql.exec("DELETE FROM kernel_fs_hydration_chunk");
      database.sql.exec(
        "DELETE FROM kernel_fs_origin WHERE ino NOT IN (SELECT ino FROM kernel_fs_inode)",
      );
    });
  }

  pending(inode: Inode): PendingFile | undefined {
    const row = firstRow(
      this.#database.sql.exec("SELECT * FROM kernel_fs_origin WHERE ino = ?", inode.toString()),
    );
    if (!row) return undefined;
    return {
      inode,
      path: String(row.path),
      at: {
        repository: String(row.repository),
        fork: String(row.fork),
        commit: String(row.source_commit),
      },
      size: BigInt(String(row.size)),
    };
  }

  attach(file: PendingFile) {
    this.#database.transactionSync(() => {
      const existing = this.pending(file.inode);
      if (existing) throw new StorageError("EEXIST");
      const chunks = firstRow(
        this.#database.sql.exec(
          "SELECT part FROM kernel_fs_chunk WHERE ino = ? LIMIT 1",
          file.inode.toString(),
        ),
      );
      if (chunks) throw new StorageError("EINVAL");
      this.#database.sql.exec(
        "INSERT INTO kernel_fs_origin VALUES (?, ?, ?, ?, ?, ?)",
        file.inode.toString(),
        file.path,
        file.at.repository,
        file.at.fork,
        file.at.commit,
        file.size.toString(),
      );
    });
  }

  begin(file: PendingFile) {
    if (this.#staging.has(file.inode)) throw new StorageError("EBUSY");
    this.#database.sql.exec(
      "DELETE FROM kernel_fs_hydration_chunk WHERE ino = ?",
      file.inode.toString(),
    );
    this.#staging.set(file.inode, { file, received: 0n });
  }

  append(inode: Inode, source: Uint8Array) {
    const staging = this.#get(inode);
    if (staging.received + BigInt(source.byteLength) > staging.file.size) {
      throw new Error("Hydration exceeded the declared file size");
    }
    const start = staging.received;
    this.#database.transactionSync(() => {
      let done = 0;
      while (done < source.byteLength) {
        const position = start + BigInt(done);
        const part = Number(position / CHUNK);
        const within = Number(position % CHUNK);
        const count = Math.min(FILE_CHUNK_BYTES - within, source.byteLength - done);
        const row = firstRow(
          this.#database.sql.exec(
            "SELECT bin FROM kernel_fs_hydration_chunk WHERE ino = ? AND part = ?",
            inode.toString(),
            part,
          ),
        );
        const chunk = new Uint8Array(within + count);
        if (row) {
          const bin = row.bin;
          if (bin instanceof ArrayBuffer) chunk.set(new Uint8Array(bin));
          else if (bin instanceof Uint8Array) chunk.set(bin);
          else throw new Error("Invalid hydration chunk");
        }
        chunk.set(source.subarray(done, done + count), within);
        this.#database.sql.exec(
          "INSERT OR REPLACE INTO kernel_fs_hydration_chunk VALUES (?, ?, ?)",
          inode.toString(),
          part,
          chunk.buffer,
        );
        done += count;
      }
    });
    staging.received += BigInt(source.byteLength);
  }

  publish(inode: Inode) {
    const staging = this.#get(inode);
    if (staging.received !== staging.file.size) {
      throw new Error("Hydration did not provide the declared file size");
    }
    this.#database.transactionSync(() => {
      const pending = this.pending(inode);
      const row = firstRow(
        this.#database.sql.exec(
          "SELECT size FROM kernel_fs_inode WHERE ino = ? AND type = 'file'",
          inode.toString(),
        ),
      );
      if (!pending || !row || String(row.size) !== staging.file.size.toString()) {
        throw new StorageError("ESTALE");
      }
      this.#database.sql.exec("DELETE FROM kernel_fs_chunk WHERE ino = ?", inode.toString());
      this.#database.sql.exec(
        "INSERT INTO kernel_fs_chunk SELECT ino, part, bin FROM kernel_fs_hydration_chunk WHERE ino = ?",
        inode.toString(),
      );
      this.#database.sql.exec("DELETE FROM kernel_fs_origin WHERE ino = ?", inode.toString());
      this.#database.sql.exec(
        "DELETE FROM kernel_fs_hydration_chunk WHERE ino = ?",
        inode.toString(),
      );
    });
    this.#staging.delete(inode);
  }

  discard(inode: Inode) {
    this.#database.sql.exec(
      "DELETE FROM kernel_fs_hydration_chunk WHERE ino = ?",
      inode.toString(),
    );
    this.#staging.delete(inode);
  }

  #get(inode: Inode) {
    const staging = this.#staging.get(inode);
    if (!staging) throw new StorageError("EINVAL");
    return staging;
  }
}
