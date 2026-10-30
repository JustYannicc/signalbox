import * as NodeSqlite from "node:sqlite";
import {
  createHarnessReleaseLedger,
  type HarnessReleaseLedger,
} from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import {
  createHarnessReleaseSqliteStore,
  type HarnessReleaseSqliteDatabase,
} from "../../src/harnessReleases/HarnessReleaseSqliteStore.ts";
import { createHarnessProjectReleaseSqliteStore } from "../../src/harnessReleases/HarnessProjectReleaseSqliteStore.ts";

/** SQLite is a build input. Only the selected records enter the Worker asset bundle. */
export async function readBuildLedger<T>(
  path: string,
  projectId: string | undefined,
  operation: (ledger: HarnessReleaseLedger) => Promise<T>,
) {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const storage: HarnessReleaseSqliteDatabase = {
      sql: {
        exec(query, ...bindings) {
          const statement = database.prepare(query);
          return statement.columns().length > 0
            ? statement.all(...bindings)
            : (statement.run(...bindings), []);
        },
      },
      transactionSync(operation) {
        database.exec("BEGIN");
        try {
          const result = operation();
          database.exec("COMMIT");
          return result;
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      },
    };
    return await operation(
      createHarnessReleaseLedger(
        projectId === undefined
          ? createHarnessReleaseSqliteStore(storage)
          : createHarnessProjectReleaseSqliteStore(storage, projectId),
      ),
    );
  } finally {
    database.close();
  }
}
