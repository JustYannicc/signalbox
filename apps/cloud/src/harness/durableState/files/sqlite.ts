import { fail } from "./errors.ts";
import type { HarnessFilesDatabase } from "./types.ts";

export const metaTable = "harness_files_meta";
export const checkpointTable = "harness_files_checkpoint";
export const entryTable = "harness_files_entry";
export const blobTable = "harness_files_blob";
export const admissionReceiptTable = "harness_files_admission_receipt";
const baseTables = [metaTable, checkpointTable, entryTable, blobTable];
const ownTables = [...baseTables, admissionReceiptTable];

export interface FilesSchemaStatus {
  readonly pristine: boolean;
  readonly migrated: boolean;
}

function createAdmissionReceiptTable(database: HarnessFilesDatabase) {
  database.sql.exec(`CREATE TABLE ${admissionReceiptTable} (
    evidence_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL
  )`);
}

export function requireOwnSchema(
  database: HarnessFilesDatabase,
  initialize: boolean,
): FilesSchemaStatus {
  const tables = [
    ...database.sql.exec(
      "SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?, ?, ?)",
      ...ownTables,
    ),
  ];
  const pristine = tables.length === 0;
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
    createAdmissionReceiptTable(database);
    return { pristine: true, migrated: false };
  }
  const byName = new Map(tables.map((table) => [table.name, table.type]));
  if (
    baseTables.some((table) => byName.get(table) !== "table") ||
    tables.some((table) => table.type !== "table")
  )
    return fail("CORRUPT");
  if (!byName.has(admissionReceiptTable)) {
    createAdmissionReceiptTable(database);
    return { pristine: false, migrated: true };
  }
  return { pristine: false, migrated: false };
}
