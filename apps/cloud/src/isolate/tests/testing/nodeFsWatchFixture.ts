// @effect-diagnostics nodeBuiltinImport:off - Watcher tests use a fresh in-memory database.
import * as NodeSqlite from "node:sqlite";
import { createFacetSqliteStorage, type FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { createNodeFs } from "../../NodeFs.ts";

export function nodeFsWatchFixture(options: { readonly changeGeneration?: boolean } = {}) {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  let transactionDepth = 0;
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
      const name = `node_watch_test_${transactionDepth++}`;
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
        transactionDepth--;
      }
    },
  };
  let time = 1_800_000_000_000_000_000n;
  const sqlite = createFacetSqliteStorage(storage, () => (time += 1_000_000n));
  const { changeGeneration: _omitted, ...withoutGeneration } = sqlite;
  const mounted = options.changeGeneration === false ? withoutGeneration : sqlite;
  const kernelFs = new KernelFileSystem({ mounts: [{ path: "/", storage: mounted }], cwd: "/" });
  return {
    kernelFs,
    storage,
    mounted,
    fs: createNodeFs(kernelFs).fs,
    close() {
      try {
        kernelFs.dispose();
      } finally {
        database.close();
      }
    },
  };
}
