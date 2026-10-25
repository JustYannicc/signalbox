// @effect-diagnostics nodeBuiltinImport:off - owned in-memory SQLite for the standalone proof tests.
import * as NodeSqlite from "node:sqlite";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";

export function sqliteFixture() {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  let depth = 0;
  const storage: FacetStorage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const name = `computer_proof_test_${depth++}`;
      database.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        database.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${name}`);
        database.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
  return { storage, close: () => database.close() };
}
