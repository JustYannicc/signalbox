// @effect-diagnostics nodeBuiltinImport:off - this fixture owns an isolated in-memory database.
import * as NodeSqlite from "node:sqlite";
import { createFacetSqliteStorage, type FacetStorage } from "../../../kernel/FacetSqliteStorage.ts";
import {
  KernelFileSystem,
  type WasiStdio,
  type KernelPosixOptions,
} from "../../../kernel/KernelFileSystem.ts";

export function createTestFilesystem(
  stdio?: readonly [WasiStdio, WasiStdio, WasiStdio],
  posix?: KernelPosixOptions,
) {
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
      const name = `computer_test_${transactionDepth++}`;
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
  const inodes = createFacetSqliteStorage(storage, () => 1_800_000_000_000_000_001n);
  if (posix !== undefined) inodes.posix.initialize(inodes.root, { mode: 0o777, uid: 0, gid: 0 });
  const filesystem = new KernelFileSystem({
    mounts: [
      {
        path: "/",
        storage: inodes,
      },
    ],
    ...(stdio === undefined ? {} : { stdio }),
    ...(posix === undefined ? {} : { posix }),
  });

  return {
    filesystem,
    storage,
    /** Computer's own storage, below the overlay. */
    upper: inodes,
    persistenceRevision: () => inodes.changeGeneration(),
    fileChanges: (since: number) => inodes.changesSince?.(since),
    close() {
      filesystem.dispose();
      database.close();
    },
  };
}
