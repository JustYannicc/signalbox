import type { HarnessRunDatabase } from "./types.ts";
import { fail } from "./errors.ts";

export const stateTable = "harness_run_state";
export const formatTable = "harness_run_format";
const ownTables = [stateTable, formatTable];

export function requireOwnSchema(database: HarnessRunDatabase, initialize: boolean) {
  const tables = [
    ...database.sql.exec("SELECT name, type FROM sqlite_master WHERE name IN (?, ?)", ...ownTables),
  ];
  const pristine = tables.length === 0;
  // Empty existing tables may have lost a live run. Recreating that state would renew launch authority.
  if (
    !pristine &&
    (tables.length !== ownTables.length || tables.some((table) => table.type !== "table"))
  )
    return fail("CORRUPT");
  if (pristine) {
    if (!initialize) return fail("MISSING");
    database.sql.exec(`CREATE TABLE ${stateTable} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), revision INTEGER NOT NULL, state_json TEXT NOT NULL
    )`);
    database.sql.exec(`CREATE TABLE ${formatTable} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), version INTEGER NOT NULL
    )`);
  }
  return pristine;
}
