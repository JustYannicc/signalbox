import { type FacetStorage, StorageError } from "./SqliteDatabase.ts";

const PREFIX = "chunked-manifest-v1:";
// At most three UTF-8 bytes per UTF-16 code unit, safely below SQLite's 2 MiB value limit.
const PART_CODE_UNITS = 128 * 1024;

export function installCommitManifest(database: FacetStorage): void {
  database.sql.exec(
    "CREATE TABLE IF NOT EXISTS kernel_fs_commit_manifest (turn_id TEXT NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (turn_id, part))",
  );
}

/** The caller's snapshot transaction owns publication of every part and its header. */
export function writeCommitManifest(database: FacetStorage, turnId: string, json: string): string {
  let part = 0;
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + PART_CODE_UNITS, json.length);
    // SQLite encodes each TEXT value independently, so never split a surrogate pair.
    const last = json.charCodeAt(end - 1);
    if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
    database.sql.exec(
      "INSERT INTO kernel_fs_commit_manifest (turn_id, part, json) VALUES (?, ?, ?)",
      turnId,
      part++,
      json.slice(offset, end),
    );
    offset = end;
  }
  return `${PREFIX}${part}`;
}

export function readCommitManifest(database: FacetStorage, turnId: string, value: unknown): string {
  const header = String(value);
  if (!header.startsWith(PREFIX)) return header;
  const count = Number(header.slice(PREFIX.length));
  if (!Number.isSafeInteger(count) || count <= 0) throw new StorageError("EIO");
  const parts: string[] = [];
  for (const row of database.sql.exec(
    "SELECT part, json FROM kernel_fs_commit_manifest WHERE turn_id = ? ORDER BY part",
    turnId,
  )) {
    if (row.part !== parts.length || typeof row.json !== "string") throw new StorageError("EIO");
    parts.push(row.json);
  }
  if (parts.length !== count) throw new StorageError("EIO");
  return parts.join("");
}

export function deleteCommitManifest(database: FacetStorage, turnId: string): void {
  database.sql.exec("DELETE FROM kernel_fs_commit_manifest WHERE turn_id = ?", turnId);
}
