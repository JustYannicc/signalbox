import { fail } from "./errors.ts";
import type { HarnessThreadSupervisorDatabase } from "./types.ts";

export const stateTable = "harness_thread_supervisor_state";
export const formatTable = "harness_thread_supervisor_format";
const ownTables = [stateTable, formatTable];

export function requireOwnSchema(database: HarnessThreadSupervisorDatabase, initialize: boolean) {
  const tables = [
    ...database.sql.exec("SELECT name, type FROM sqlite_master WHERE name IN (?, ?)", ...ownTables),
  ];
  const pristine = tables.length === 0;
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
