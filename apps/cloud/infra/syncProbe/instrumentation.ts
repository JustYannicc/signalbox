interface SqlActivity {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
}

interface SqlCursor {
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
}

/** Capture the per-object SQL counters that workerd attaches to every cursor. */
export function instrument(state: DurableObjectState) {
  const raw = state.storage.sql;
  const cursors: SqlCursor[] = [];
  const sql = new Proxy(raw, {
    get(target, key) {
      if (key === "exec")
        return (statement: string, ...args: unknown[]) => {
          const cursor = Reflect.apply(target.exec, target, [statement, ...args]) as SqlCursor;
          cursors.push(cursor);
          return cursor;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const storage = new Proxy(state.storage, {
    get(target, key) {
      if (key === "sql") return sql;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(state, {
    get(target, key) {
      if (key === "storage") return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    state: wrapped,
    snapshot(): SqlActivity {
      let rowsRead = 0;
      let rowsWritten = 0;
      for (const cursor of cursors) {
        rowsRead += cursor.rowsRead ?? 0;
        rowsWritten += cursor.rowsWritten ?? 0;
      }
      const activity = { rowsRead, rowsWritten, statements: cursors.length };
      cursors.length = 0;
      return activity;
    },
  };
}
