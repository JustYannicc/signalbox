// @effect-diagnostics nodeBuiltinImport:off - owned temporary SQLite files exercise reconstruction and rollback.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";

export function hostSqlite() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "harness-host-"));
  const path = NodePath.join(directory, "files.sqlite");
  const handles = new Set<ReturnType<typeof open>>();
  function open() {
    const db = new NodeSqlite.DatabaseSync(path);
    let depth = 0;
    let fail: ((query: string) => boolean) | undefined;
    const storage: FacetStorage = {
      sql: {
        get databaseSize() {
          return 0;
        },
        exec(query, ...bindings) {
          const statement = db.prepare(query);
          const args = bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          );
          const rows = statement.columns().length
            ? statement.all(...args)
            : (statement.run(...args), []);
          if (fail?.(query)) {
            fail = undefined;
            throw new Error("Injected transaction failure");
          }
          return rows;
        },
      },
      transactionSync(callback) {
        const savepoint = `host_test_${depth++}`;
        db.exec(`SAVEPOINT ${savepoint}`);
        try {
          const value = callback();
          db.exec(`RELEASE ${savepoint}`);
          return value;
        } catch (error) {
          db.exec(`ROLLBACK TO ${savepoint}`);
          db.exec(`RELEASE ${savepoint}`);
          throw error;
        } finally {
          depth--;
        }
      },
    };
    const handle = {
      storage,
      failOnce: (predicate: (query: string) => boolean) => {
        fail = predicate;
      },
      rows: (query: string) => db.prepare(query).all(),
      exec: (query: string) => db.exec(query),
      inode(path: string) {
        let inode = "1";
        for (const part of path.slice(1).split("/")) {
          const row = db
            .prepare("SELECT ino FROM kernel_fs_entry WHERE parent=? AND name=?")
            .get(inode, part);
          if (typeof row?.ino !== "string") throw new Error("Missing fixture inode");
          inode = row.ino;
        }
        return inode;
      },
      close() {
        if (handles.delete(handle)) db.close();
      },
    };
    handles.add(handle);
    return handle;
  }
  return {
    open,
    dispose() {
      for (const handle of handles) handle.close();
      NodeFS.rmSync(directory, { recursive: true });
    },
  };
}
