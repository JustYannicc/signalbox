import * as NodeSqlite from "node:sqlite";
import type { FacetStorage } from "../kernel/FacetSqliteStorage.ts";

export function sqliteFixture() {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  const statements = new Map<string, NodeSqlite.StatementSync>();
  const schema = database.prepare("PRAGMA schema_version");
  let schemaVersion = schema.get()?.schema_version;
  let depth = 0;
  const storage: FacetStorage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const version = schema.get()?.schema_version;
        if (version !== schemaVersion) {
          // Node's cached result columns can outlive a SQLite schema change.
          statements.clear();
          schemaVersion = version;
        }
        let statement = statements.get(query);
        if (!statement) {
          statement = database.prepare(query);
          statements.set(query, statement);
        }
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.all(...values);
      },
    },
    transactionSync(callback) {
      const name = `computer_test_${depth++}`;
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
  return {
    storage,
    close() {
      statements.clear();
      database.close();
    },
  };
}
