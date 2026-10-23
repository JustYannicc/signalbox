// @effect-diagnostics nodeBuiltinImport:off - owned in-memory storage for facet integration tests.
import * as NodeSqlite from "node:sqlite";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";

export const facetSqlite = () => {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  let depth = 0;
  const storage: FacetStorage = {
    sql: {
      databaseSize: 0,
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const savepoint = `thread_facet_${depth++}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = callback();
        database.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
  return { storage, dispose: () => database.close() };
};
