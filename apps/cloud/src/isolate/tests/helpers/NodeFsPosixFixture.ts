// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory test database, never live userdata.
import * as NodeSqlite from "node:sqlite";
import { createFacetSqliteStorage, type FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
const clock = () => 1_800_000_000_000_000_001n;

export function nodeFsPosixFixture(posix = true) {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  let transactionDepth = 0;
  const facetStorage: FacetStorage = {
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
      const name = `node_fs_review_${transactionDepth++}`;
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
  const storage = createFacetSqliteStorage(facetStorage, clock);
  if (posix) storage.posix.initialize(storage.root, { mode: 0o755, uid: 1000, gid: 1000 });
  const kernelFs = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    cwd: "/",
    ...(posix
      ? {
          posix: {
            credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
            umask: 0o022,
          },
        }
      : {}),
  });
  return {
    kernelFs,
    storage,
    close() {
      try {
        kernelFs.dispose();
      } finally {
        database.close();
      }
    },
  };
}
