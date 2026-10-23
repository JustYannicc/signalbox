import { fail } from "./errors.ts";
import type { HarnessFilesDatabase } from "./types.ts";

export const metaTable = "harness_files_meta";
export const checkpointTable = "harness_files_checkpoint";
export const entryTable = "harness_files_entry";
export const blobTable = "harness_files_blob";
const ownTables = [metaTable, checkpointTable, entryTable, blobTable];

export function requireOwnSchema(database: HarnessFilesDatabase, initialize: boolean) {
  const tables = [
    ...database.sql.exec(
      "SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?, ?)",
      ...ownTables,
    ),
  ];
  const pristine = tables.length === 0;
  if (
    !pristine &&
    (tables.length !== ownTables.length || tables.some((table) => table.type !== "table"))
  )
    return fail("CORRUPT");
  if (pristine) {
    if (!initialize) return fail("MISSING");
    database.sql.exec(`CREATE TABLE ${metaTable} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), revision INTEGER NOT NULL, state_json TEXT NOT NULL
    )`);
    database.sql.exec(`CREATE TABLE ${checkpointTable} (
      checkpoint_id TEXT PRIMARY KEY, parent_checkpoint_id TEXT, manifest_sha256 TEXT NOT NULL,
      file_count INTEGER NOT NULL, byte_count INTEGER NOT NULL
    )`);
    database.sql.exec(`CREATE TABLE ${entryTable} (
      checkpoint_id TEXT NOT NULL, path TEXT NOT NULL, mode INTEGER NOT NULL,
      blob_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, path)
    )`);
    database.sql.exec(`CREATE TABLE ${blobTable} (
      sha256 TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, bytes BLOB NOT NULL
    )`);
  }
  return pristine;
}
