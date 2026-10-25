import { createHarnessThreadSupervisor } from "../../HarnessThreadSupervisor.ts";

type SupervisorDatabase = Parameters<typeof createHarnessThreadSupervisor>[0];

const formatTable = "harness_thread_supervisor_format";
const reconciliationTable = "harness_thread_supervisor_reconciliation";

export function downgradeSupervisorSchemaToV1(database: SupervisorDatabase) {
  database.sql.exec(`DROP INDEX IF EXISTS ${reconciliationTable}_one_pending`);
  database.sql.exec(`DROP TABLE IF EXISTS ${reconciliationTable}`);
  database.sql.exec(`UPDATE ${formatTable} SET version = 1 WHERE slot = 1`);
}

export function readSupervisorSchema(database: SupervisorDatabase) {
  const versionRows = database.sql.exec(`SELECT version FROM ${formatTable} WHERE slot = 1`);
  const tableRows = database.sql.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    reconciliationTable,
  );
  return {
    version: [...versionRows][0]?.version,
    reconciliationTable: [...tableRows].some((row) => row.name === reconciliationTable),
  };
}
