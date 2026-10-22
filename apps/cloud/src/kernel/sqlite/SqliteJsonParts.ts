import { type FacetStorage, StorageError } from "./SqliteDatabase.ts";

const PREFIX = "chunked-manifest-v1:";
// At most three UTF-8 bytes per UTF-16 code unit, safely below SQLite's 2 MiB value limit.
const PART_CODE_UNITS = 128 * 1024;

type PartTable = "kernel_fs_commit_manifest" | "kernel_fs_workspace_manifest";

export function createSqliteJsonParts(database: FacetStorage, table: PartTable) {
  const keyColumn = table === "kernel_fs_commit_manifest" ? "turn_id" : "owner_key";
  const install = () => {
    database.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (${keyColumn} TEXT NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (${keyColumn}, part))`,
    );
  };

  // The caller's transaction owns publication of every part and its header.
  const write = (key: string, json: string): string => {
    let part = 0;
    for (let offset = 0; offset < json.length;) {
      let end = Math.min(offset + PART_CODE_UNITS, json.length);
      // SQLite encodes each TEXT value independently, so never split a surrogate pair.
      const last = json.charCodeAt(end - 1);
      if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
      database.sql.exec(
        `INSERT INTO ${table} (${keyColumn}, part, json) VALUES (?, ?, ?)`,
        key,
        part++,
        json.slice(offset, end),
      );
      offset = end;
    }
    return `${PREFIX}${part}`;
  };

  const read = (key: string, value: unknown): string => {
    const header = String(value);
    if (!header.startsWith(PREFIX)) return header;
    const count = Number(header.slice(PREFIX.length));
    if (!Number.isSafeInteger(count) || count <= 0) throw new StorageError("EIO");
    const parts: string[] = [];
    for (const row of database.sql.exec(
      `SELECT part, json FROM ${table} WHERE ${keyColumn} = ? ORDER BY part`,
      key,
    )) {
      if (row.part !== parts.length || typeof row.json !== "string") throw new StorageError("EIO");
      parts.push(row.json);
    }
    if (parts.length !== count) throw new StorageError("EIO");
    return parts.join("");
  };

  const remove = (key: string): void => {
    database.sql.exec(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, key);
  };
  return { install, write, read, remove };
}
