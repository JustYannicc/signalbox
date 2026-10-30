import type { FacetStorage } from "../../../../src/kernel/FacetSqliteStorage.ts";

const chunkQuery = "SELECT bin FROM kernel_fs_chunk WHERE ino = ? AND part = ?";

// Counts returned SQLite chunks, including read-modify-write fetches. This overcounts
// application reads; it cannot hide a full scan of the registered resident files.
export function observeChunkReads(database: FacetStorage) {
  const paths = new Map<string, string>();
  const rows: { phase: string; path: string | null; inode: string; part: number; bytes: number }[] =
    [];
  let phase = "unmeasured";
  const storage: FacetStorage = {
    sql: {
      get databaseSize() {
        return database.sql.databaseSize;
      },
      exec(query, ...bindings) {
        const result = database.sql.exec(query, ...bindings);
        if (query !== chunkQuery) return result;
        const materialized = [...result];
        const inode = bindings[0];
        const part = bindings[1];
        if (typeof inode !== "string" || typeof part !== "number")
          throw new Error("Pinned chunk-read bindings changed.");
        for (const row of materialized) {
          const bytes = row.bin;
          if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array))
            throw new Error("Pinned chunk-read result changed.");
          rows.push({
            phase,
            path: paths.get(inode) ?? null,
            inode,
            part,
            bytes: bytes.byteLength,
          });
        }
        return materialized;
      },
    },
    transactionSync: (callback) => database.transactionSync(callback),
  };
  return {
    storage,
    register(path: string, inode: bigint) {
      const previous = paths.get(inode.toString());
      if (previous !== undefined && previous !== path)
        throw new Error("Read-accounting fixture requires unique tracked inodes.");
      paths.set(inode.toString(), path);
    },
    phase(value: string) {
      phase = value;
    },
    snapshot() {
      return rows.map((row) => ({ ...row }));
    },
  };
}
