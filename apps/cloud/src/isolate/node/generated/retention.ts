import type { FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { NodeGeneratedCodeInputError, NodeGeneratedCodeIntegrityError } from "./errors.ts";

export interface NodeGeneratedCodeRetentionLimits {
  readonly maxEntries?: number;
  /** UTF-8 module name, source and identity bytes, plus 256 bytes per entry. */
  readonly maxBytes?: number;
}

export const NODE_GENERATED_CODE_DEFAULT_RETENTION = Object.freeze({
  maxEntries: 128,
  maxBytes: 4 * 1024 * 1024,
});

const retentionTable = "node_generated_code_retention_v1";
const dataTables = [
  "node_generated_code_v1",
  "node_generated_code_chunk_v1",
  "node_generated_function_index_v1",
  "node_generated_function_index_chunk_v1",
];
const overhead = 256;

/** SQLite owns eviction so opening an older cache never reconstructs its unbounded source history. */
export function createGeneratedCodeRetention(
  storage: FacetStorage,
  scopeId: string,
  limits: NodeGeneratedCodeRetentionLimits = {},
) {
  const maxEntries = limits.maxEntries ?? NODE_GENERATED_CODE_DEFAULT_RETENTION.maxEntries;
  const maxBytes = limits.maxBytes ?? NODE_GENERATED_CODE_DEFAULT_RETENTION.maxBytes;
  for (const value of [maxEntries, maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new NodeGeneratedCodeInputError(
        "Generated-code retention limits must be non-negative safe integers",
      );
    }
  }
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${retentionTable} (
    scope_id TEXT NOT NULL,
    code_key TEXT NOT NULL,
    module_bytes INTEGER NOT NULL,
    identity_bytes INTEGER NOT NULL,
    PRIMARY KEY (scope_id, code_key)
  )`);

  const trim = () => {
    const rows = Array.from(
      storage.sql.exec(
        `SELECT rowid AS sequence, code_key, module_bytes, identity_bytes FROM ${retentionTable}
       WHERE scope_id = ? ORDER BY rowid DESC LIMIT ?`,
        scopeId,
        maxEntries,
      ),
    );
    let bytes = 0;
    let oldest: number | undefined;
    for (const row of rows) {
      const moduleBytes = row.module_bytes;
      const identityBytes = row.identity_bytes;
      const sequence = row.sequence;
      if (
        !validBytes(moduleBytes) ||
        !validBytes(identityBytes) ||
        typeof sequence !== "number" ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1
      ) {
        throw new NodeGeneratedCodeIntegrityError(String(row.code_key));
      }
      const cost = moduleBytes + identityBytes + overhead;
      if (cost > maxBytes - bytes) break;
      bytes += cost;
      oldest = sequence;
    }
    if (oldest === undefined)
      storage.sql.exec(`DELETE FROM ${retentionTable} WHERE scope_id = ?`, scopeId);
    else
      storage.sql.exec(
        `DELETE FROM ${retentionTable} WHERE scope_id = ? AND rowid < ?`,
        scopeId,
        oldest,
      );
    // Old entries without bounded accounting are disposable cache data. Do not read their source to migrate them.
    for (const table of dataTables) {
      storage.sql.exec(
        `DELETE FROM ${table} WHERE scope_id = ? AND NOT EXISTS (
        SELECT 1 FROM ${retentionTable} r WHERE r.scope_id = ${table}.scope_id AND r.code_key = ${table}.code_key
      )`,
        scopeId,
      );
    }
  };
  storage.transactionSync(trim);

  return {
    fits(moduleBytes: number, identityBytes: number): boolean {
      return maxEntries > 0 && moduleBytes + identityBytes + overhead <= maxBytes;
    },
    retain(key: string, moduleBytes: number, identityBytes: number, write: () => void): boolean {
      if (maxEntries === 0 || moduleBytes + identityBytes + overhead > maxBytes) return false;
      storage.transactionSync(() => {
        write();
        storage.sql.exec(
          `DELETE FROM ${retentionTable} WHERE scope_id = ? AND code_key = ?`,
          scopeId,
          key,
        );
        storage.sql.exec(
          `INSERT INTO ${retentionTable} (scope_id, code_key, module_bytes, identity_bytes)
          VALUES (?, ?, ?, ?)`,
          scopeId,
          key,
          moduleBytes,
          identityBytes,
        );
        trim();
      });
      return true;
    },
    entries(): Record<string, unknown>[] {
      return storage.transactionSync(() => {
        trim();
        return Array.from(
          storage.sql.exec(
            `SELECT r.code_key, r.module_bytes, r.identity_bytes, c.module_source_hash, c.chunk_count
           FROM ${retentionTable} r LEFT JOIN node_generated_code_v1 c
           ON c.scope_id = r.scope_id AND c.code_key = r.code_key
           WHERE r.scope_id = ? ORDER BY r.code_key ASC LIMIT ?`,
            scopeId,
            maxEntries,
          ),
        );
      });
    },
  };
}

function validBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
