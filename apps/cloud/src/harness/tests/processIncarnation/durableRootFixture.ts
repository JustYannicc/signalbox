// @effect-diagnostics nodeBuiltinImport:off - receiver fences need a real local SQLite transaction.
import * as NodeSqlite from "node:sqlite";

type StorageTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<void>;
  delete(key: string | string[]): Promise<number>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
};

export function durableRootContext(name: string) {
  const sqlite = new NodeSqlite.DatabaseSync(":memory:");
  const values = new Map<string, unknown>();
  let transactionTail = Promise.resolve();
  let sqlDepth = 0;

  const transaction = async <A>(operation: (tx: StorageTransaction) => Promise<A>) => {
    const prior = transactionTail;
    let release!: () => void;
    transactionTail = new Promise<void>((resolve) => (release = resolve));
    await prior;

    const pending = new Map(values);
    const tx: StorageTransaction = {
      async get<T>(key: string) {
        return pending.get(key) as T | undefined;
      },
      async put(keyOrValues, value) {
        if (typeof keyOrValues === "string") pending.set(keyOrValues, value);
        else for (const [key, entry] of Object.entries(keyOrValues)) pending.set(key, entry);
      },
      async delete(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        let count = 0;
        for (const key of list) if (pending.delete(key)) count++;
        return count;
      },
      async list<T>(options: { prefix?: string } = {}) {
        const prefix = options.prefix ?? "";
        return new Map(
          [...pending.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
        );
      },
    };

    try {
      const result = await operation(tx);
      values.clear();
      for (const [key, value] of pending) values.set(key, value);
      return result;
    } finally {
      release();
    }
  };

  const storage = {
    sql: {
      exec(query: string, ...bindings: (string | number | null | Uint8Array | ArrayBuffer)[]) {
        const statement = sqlite.prepare(query);
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync<A>(operation: () => A): A {
      const depth = sqlDepth++;
      const boundary = depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT harness_test_${depth}`;
      sqlite.exec(boundary);
      try {
        const result = operation();
        sqlite.exec(depth === 0 ? "COMMIT" : `RELEASE harness_test_${depth}`);
        return result;
      } catch (error) {
        if (depth === 0) sqlite.exec("ROLLBACK");
        else {
          sqlite.exec(`ROLLBACK TO harness_test_${depth}`);
          sqlite.exec(`RELEASE harness_test_${depth}`);
        }
        throw error;
      } finally {
        sqlDepth--;
      }
    },
    get<T>(key: string) {
      return Promise.resolve(values.get(key) as T | undefined);
    },
    put(key: string | Record<string, unknown>, value?: unknown) {
      return transaction((tx) => tx.put(key, value));
    },
    delete(keys: string | string[]) {
      return transaction((tx) => tx.delete(keys));
    },
    list<T>(options?: { prefix?: string }) {
      return transaction((tx) => tx.list<T>(options));
    },
    transaction,
  };

  const context = {
    id: { name, toString: () => name },
    storage,
    blockConcurrencyWhile<A>(callback: () => Promise<A>) {
      return callback();
    },
    abort(reason?: string) {
      throw new Error(reason ?? "Aborted by test fixture.");
    },
  };

  return {
    context,
    storage,
    rows(query: string, ...bindings: (string | number | null)[]) {
      return sqlite.prepare(query).all(...bindings);
    },
    close() {
      sqlite.close();
    },
  };
}
