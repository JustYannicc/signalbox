import { fail } from "./errors.ts";
import type { HarnessThreadSupervisorDatabase } from "./types.ts";

export const stateTable = "harness_thread_supervisor_state";
export const formatTable = "harness_thread_supervisor_format";
export const reconciliationTable = "harness_thread_supervisor_reconciliation";
const ownTables = [stateTable, formatTable, reconciliationTable];
const baseTables = [stateTable, formatTable];

function createReconciliationTable(database: HarnessThreadSupervisorDatabase) {
  database.sql.exec(`CREATE TABLE ${reconciliationTable} (
    evidence_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
    receipt_json TEXT NOT NULL
  )`);
  database.sql.exec(
    `CREATE UNIQUE INDEX ${reconciliationTable}_one_pending ON ${reconciliationTable} (status) WHERE status = 'pending'`,
  );
}

export function requireOwnSchema(database: HarnessThreadSupervisorDatabase, initialize: boolean) {
  const tables = [
    ...database.sql.exec(
      "SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?)",
      ...ownTables,
    ),
  ];
  const pristine = tables.length === 0;
  if (pristine) {
    if (!initialize) return fail("MISSING");
    database.sql.exec(`CREATE TABLE ${stateTable} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), revision INTEGER NOT NULL, state_json TEXT NOT NULL
    )`);
    database.sql.exec(`CREATE TABLE ${formatTable} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), version INTEGER NOT NULL
    )`);
    createReconciliationTable(database);
    return true;
  }
  const byName = new Map(tables.map((table) => [table.name, table.type]));
  if (
    baseTables.some((table) => byName.get(table) !== "table") ||
    tables.some((table) => table.type !== "table")
  )
    return fail("CORRUPT");

  const format = database.sql.exec(`SELECT version FROM ${formatTable} WHERE slot = 1`);
  const version = format[Symbol.iterator]().next().value?.version;
  if (version === 1 && !byName.has(reconciliationTable)) {
    createReconciliationTable(database);
    database.sql.exec(`UPDATE ${formatTable} SET version = 2 WHERE slot = 1 AND version = 1`);
    return false;
  }
  if (version !== 2 || !byName.has(reconciliationTable)) return fail("CORRUPT");
  return false;
}
