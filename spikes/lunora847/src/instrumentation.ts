/** Measures workerd's cursor counters, including Lunora's internal bookkeeping. */
export function instrument(state: DurableObjectState) {
  const kv = { puts: 0, deletes: 0, setAlarm: 0, deleteAlarm: 0 };
  const cursors: { rowsRead: number; rowsWritten: number }[] = [];
  const raw = state.storage.sql;
  if (!raw) throw new Error("SQLite is required");
  const sql = new Proxy(raw, {
    get(target, key) {
      if (key === "exec")
        return (statement: string, ...args: unknown[]) => {
          const cursor = Reflect.apply(target.exec, target, [statement, ...args]);
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
      if (["put", "delete", "setAlarm", "deleteAlarm"].includes(String(key)))
        return (...args: unknown[]) => {
          if (key === "put")
            kv.puts += typeof args[0] === "string" ? 1 : Object.keys(args[0] ?? {}).length;
          if (key === "delete") kv.deletes += Array.isArray(args[0]) ? args[0].length : 1;
          if (key === "setAlarm") kv.setAlarm++;
          if (key === "deleteAlarm") kv.deleteAlarm++;
          return Reflect.apply(Reflect.get(target, key, target), target, args);
        };
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
    snapshot() {
      const result = { statements: cursors.length, rowsRead: 0, rowsWritten: 0 };
      for (const cursor of cursors) {
        result.rowsRead += cursor.rowsRead ?? 0;
        result.rowsWritten += cursor.rowsWritten ?? 0;
      }
      cursors.length = 0;
      const other = { ...kv };
      kv.puts = kv.deletes = kv.setAlarm = kv.deleteAlarm = 0;
      return { ...result, kv: other };
    },
  };
}
