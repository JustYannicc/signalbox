// @effect-diagnostics nodeBuiltinImport:off - disposable in-memory SQLite, never live userdata.
import * as NodeSqlite from "node:sqlite";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";

export function nodeGeneratedCodeSqliteFixture() {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  let depth = 0;
  const storage: FacetStorage = {
    sql: {
      databaseSize: 0,
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        if (statement.columns().length) return statement.all(...values);
        statement.run(...values);
        return [];
      },
    },
    transactionSync(callback) {
      const name = `node_generated_test_${depth++}`;
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
  return { storage, database, close: () => database.close() };
}
