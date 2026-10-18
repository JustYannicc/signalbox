import type {
  ChangedInode,
  CommitInode,
  FileCommitReceipt,
  ForkCommit,
} from "../FilePersistencePorts.ts";
import type { Inode, Stat, Storage } from "../storage.ts";
import { FILE_CHUNK_BYTES } from "./SqliteChunks.ts";
import { firstRow, type FacetStorage, StorageError } from "./SqliteDatabase.ts";

const CHUNK = BigInt(FILE_CHUNK_BYTES);

interface EncodedStat {
  readonly type: Stat["type"];
  readonly size: string;
  readonly nlink: string;
  readonly atimeNs: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface SnapshotEntry {
  readonly inode: string;
  readonly paths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly stat: EncodedStat | null;
  readonly symlinkTarget: string | null;
}

const encodeStat = (stat: Stat): EncodedStat => ({
  type: stat.type,
  size: stat.size.toString(),
  nlink: stat.nlink.toString(),
  atimeNs: stat.atimeNs.toString(),
  mtimeNs: stat.mtimeNs.toString(),
  ctimeNs: stat.ctimeNs.toString(),
});

const decodeStat = (value: EncodedStat | null): Stat | null => {
  if (value === null) return null;
  return {
    type: value.type,
    size: BigInt(value.size),
    nlink: BigInt(value.nlink),
    atimeNs: BigInt(value.atimeNs),
    mtimeNs: BigInt(value.mtimeNs),
    ctimeNs: BigInt(value.ctimeNs),
  };
};

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === code
  );
}

function readChunks(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StorageError("EIO");
}

function decodeEntries(value: unknown): SnapshotEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new StorageError("EIO");
  }
  if (!Array.isArray(parsed)) throw new StorageError("EIO");
  return parsed.map((candidate): SnapshotEntry => {
    if (typeof candidate !== "object" || candidate === null) throw new StorageError("EIO");
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.inode !== "string" ||
      !/^[1-9][0-9]*$/.test(entry.inode) ||
      !Array.isArray(entry.paths) ||
      !entry.paths.every((path) => typeof path === "string") ||
      !Array.isArray(entry.removedPaths) ||
      !entry.removedPaths.every((path) => typeof path === "string") ||
      (entry.symlinkTarget !== null && typeof entry.symlinkTarget !== "string")
    ) {
      throw new StorageError("EIO");
    }
    let stat: EncodedStat | null = null;
    if (entry.stat !== null) {
      if (typeof entry.stat !== "object" || entry.stat === null) throw new StorageError("EIO");
      const encoded = entry.stat as Record<string, unknown>;
      if (
        (encoded.type !== "file" && encoded.type !== "directory" && encoded.type !== "symlink") ||
        typeof encoded.size !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(encoded.size) ||
        typeof encoded.nlink !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(encoded.nlink) ||
        typeof encoded.atimeNs !== "string" ||
        !/^-?(0|[1-9][0-9]*)$/.test(encoded.atimeNs) ||
        typeof encoded.mtimeNs !== "string" ||
        !/^-?(0|[1-9][0-9]*)$/.test(encoded.mtimeNs) ||
        typeof encoded.ctimeNs !== "string" ||
        !/^-?(0|[1-9][0-9]*)$/.test(encoded.ctimeNs)
      ) {
        throw new StorageError("EIO");
      }
      stat = encoded as unknown as EncodedStat;
    }
    return {
      inode: entry.inode,
      paths: [...entry.paths] as string[],
      removedPaths: [...entry.removedPaths] as string[],
      stat,
      symlinkTarget: entry.symlinkTarget,
    };
  });
}

/** Durable, bounded-memory file snapshots for one turn's remote commit attempt. */
export class SqliteCommitSnapshot {
  private readonly db: FacetStorage;
  private readonly fs: Storage;
  constructor(db: FacetStorage, fs: Storage) {
    this.db = db;
    this.fs = fs;
    db.transactionSync(() => {
      db.sql.exec(
        "CREATE TABLE IF NOT EXISTS kernel_fs_commit_receipt (repository TEXT NOT NULL, fork_name TEXT NOT NULL, base_commit TEXT NOT NULL, turn_id TEXT NOT NULL, commit_id TEXT NOT NULL, PRIMARY KEY (repository, fork_name, base_commit, turn_id))",
      );
      db.sql.exec(
        "CREATE TABLE IF NOT EXISTS kernel_fs_commit_snapshot (turn_id TEXT PRIMARY KEY, repository TEXT NOT NULL, fork_name TEXT NOT NULL, commit_id TEXT NOT NULL, manifest_json TEXT NOT NULL)",
      );
      db.sql.exec(
        "CREATE TABLE IF NOT EXISTS kernel_fs_commit_snapshot_chunk (turn_id TEXT NOT NULL, ino TEXT NOT NULL, part INTEGER NOT NULL, bin BLOB NOT NULL, PRIMARY KEY (turn_id, ino, part))",
      );
    });
  }

  receipt(at: ForkCommit, turnId: string): FileCommitReceipt | undefined {
    const row = firstRow(
      this.db.sql.exec(
        "SELECT commit_id FROM kernel_fs_commit_receipt WHERE repository = ? AND fork_name = ? AND base_commit = ? AND turn_id = ?",
        at.repository,
        at.fork,
        at.commit,
        turnId,
      ),
    );
    return row ? { commit: String(row.commit_id) } : undefined;
  }

  complete(at: ForkCommit, turnId: string, receipt: FileCommitReceipt) {
    this.db.transactionSync(() => {
      this.db.sql.exec(
        "INSERT OR IGNORE INTO kernel_fs_commit_receipt VALUES (?, ?, ?, ?, ?)",
        at.repository,
        at.fork,
        at.commit,
        turnId,
        receipt.commit,
      );
      this.db.sql.exec("DELETE FROM kernel_fs_commit_snapshot_chunk WHERE turn_id = ?", turnId);
      this.db.sql.exec("DELETE FROM kernel_fs_commit_snapshot WHERE turn_id = ?", turnId);
    });
  }

  has(at: ForkCommit, turnId: string) {
    const row = firstRow(
      this.db.sql.exec(
        "SELECT repository, fork_name, commit_id FROM kernel_fs_commit_snapshot WHERE turn_id = ?",
        turnId,
      ),
    );
    if (!row) return false;
    if (
      row.repository !== at.repository ||
      row.fork_name !== at.fork ||
      row.commit_id !== at.commit
    ) {
      throw new StorageError("ESTALE");
    }
    return true;
  }

  getOrCreate(
    at: ForkCommit,
    turnId: string,
    changed: readonly ChangedInode[],
  ): readonly CommitInode[] {
    if (!turnId) throw new StorageError("EINVAL");

    return this.db.transactionSync(() => {
      const existing = firstRow(
        this.db.sql.exec(
          "SELECT repository, fork_name, commit_id, manifest_json FROM kernel_fs_commit_snapshot WHERE turn_id = ?",
          turnId,
        ),
      );
      if (existing) {
        if (
          existing.repository !== at.repository ||
          existing.fork_name !== at.fork ||
          existing.commit_id !== at.commit
        ) {
          throw new StorageError("ESTALE");
        }
        return this.#inodes(turnId, decodeEntries(existing.manifest_json));
      }

      const seen = new Set<string>();
      for (const entry of changed) {
        const inode = entry.inode.toString();
        if (seen.has(inode)) throw new StorageError("EINVAL");
        seen.add(inode);
      }

      const entries: SnapshotEntry[] = [];
      for (const item of changed) {
        let stat: Stat | null;
        try {
          stat = this.fs.stat(item.inode);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          stat = null;
        }
        if (stat?.nlink === 0n) stat = null;

        let symlinkTarget: string | null = null;
        if (stat?.type === "symlink") symlinkTarget = this.fs.readlink(item.inode);
        if (stat?.type === "file") {
          this.db.sql.exec(
            "INSERT INTO kernel_fs_commit_snapshot_chunk (turn_id, ino, part, bin) SELECT ?, ino, part, bin FROM kernel_fs_chunk WHERE ino = ?",
            turnId,
            item.inode.toString(),
          );
        }
        entries.push({
          inode: item.inode.toString(),
          paths: [...item.paths],
          removedPaths: [...item.removedPaths],
          stat: stat === null ? null : encodeStat(stat),
          symlinkTarget,
        });
      }

      this.db.sql.exec(
        "INSERT INTO kernel_fs_commit_snapshot (turn_id, repository, fork_name, commit_id, manifest_json) VALUES (?, ?, ?, ?, ?)",
        turnId,
        at.repository,
        at.fork,
        at.commit,
        JSON.stringify(entries),
      );
      return this.#inodes(turnId, entries);
    });
  }

  #inodes(turnId: string, entries: readonly SnapshotEntry[]): readonly CommitInode[] {
    return entries.map((entry) => {
      const inode = BigInt(entry.inode) as Inode;
      const stat = decodeStat(entry.stat);
      return Object.freeze({
        inode,
        paths: Object.freeze([...entry.paths]),
        removedPaths: Object.freeze([...entry.removedPaths]),
        stat: stat === null ? null : Object.freeze(stat),
        symlinkTarget: entry.symlinkTarget,
        readChunks: () =>
          this.#readChunks(turnId, entry.inode, stat?.type === "file" ? stat.size : 0n),
      });
    });
  }

  async *#readChunks(turnId: string, inode: string, size: bigint): AsyncIterable<Uint8Array> {
    for (let offset = 0n; offset < size; offset += CHUNK) {
      const count = Number(size - offset < CHUNK ? size - offset : CHUNK);
      const part = Number(offset / CHUNK);
      const row = firstRow(
        this.db.sql.exec(
          "SELECT bin FROM kernel_fs_commit_snapshot_chunk WHERE turn_id = ? AND ino = ? AND part = ?",
          turnId,
          inode,
          part,
        ),
      );
      const chunk = new Uint8Array(count);
      if (row) chunk.set(readChunks(row.bin).subarray(0, count));
      yield chunk;
    }
  }
}
