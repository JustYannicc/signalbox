import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("keeps large text and blob parameters off cached statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<NodeSqlite.StatementSync> = [];
    const all = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
          this: NodeSqlite.StatementSync,
          ...params
        ) {
          statements.push(this);
          return all.apply(this, params);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const small = "small";
    const queries = [
      (value: string | Uint8Array | ArrayBuffer) => sql`SELECT length(${value}) AS size`,
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS size", [{ $value: value }]),
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS callable", [
          Object.assign(() => {}, { $value: value }),
        ]),
    ];
    const cached = new Set<NodeSqlite.StatementSync>();
    const large = new Set<NodeSqlite.StatementSync>();
    const largeBlobs = [new Uint8Array(64 * 1024 + 1), new ArrayBuffer(64 * 1024 + 1)];
    for (const value of [small, largeText, ...largeBlobs, small]) {
      const expected = typeof value === "string" ? value.length : value.byteLength;
      for (const query of queries) {
        assert.deepEqual((yield* query(value)).map(Object.values), [[expected]]);
        assert.deepEqual(yield* query(value).values, [[expected]]);
        for (const statement of statements.splice(0)) {
          (value === small ? cached : large).add(statement);
        }
      }
    }

    assert.equal(cached.size, queries.length);
    assert.equal(large.size, queries.length * 6);
    assert.isTrue(cached.isDisjointFrom(large));
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a parameter it cannot measure for the statement to handle", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const detached = new DataView(new ArrayBuffer(8));
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    // What a detached view binds as varies by Node version; match the statement itself.
    const native = new NodeSqlite.DatabaseSync(":memory:");
    const expected = native.prepare("SELECT length(?) AS size").all(detached);
    native.close();
    assert.deepEqual(yield* sql`SELECT length(${detached}) AS size`, expected);

    const throwing = {
      get $value(): string {
        throw new Error("unreadable");
      },
    };
    const error = yield* sql.unsafe("SELECT length($value) AS size", [throwing]).pipe(Effect.flip);
    assert.equal(error.reason.operation, "execute");

    let reads = 0;
    const counting = {
      get $value(): number {
        return ++reads;
      },
    };
    assert.deepEqual(yield* sql.unsafe("SELECT $value AS value", [counting]), [{ value: 1 }]);
    assert.equal(reads, 1);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // With a deferred BEGIN this commit lands and the write below fails
          // with SQLITE_BUSY_SNAPSHOT, which no busy timeout can wait out.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("labels SQL spans with their connection and how long they waited for its lock", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return withReaderClient((sql) =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(held);
      const statement = yield* Effect.forkChild(sql`SELECT 1`, { startImmediately: true });
      const transaction = yield* Effect.forkChild(sql.withTransaction(countEntries(sql)), {
        startImmediately: true,
      });
      yield* TestClock.adjust("25 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(statement);
      yield* Fiber.join(transaction);
      yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
    }),
  ).pipe(
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      const labeled = spans
        .filter((span) => span.attributes.has("db.connection"))
        .map((span) => [
          span.name,
          span.attributes.get("db.connection"),
          span.attributes.get("db.lock_wait_ms"),
        ]);
      assert.deepStrictEqual(labeled.slice(3), [
        ["sql.transaction", "writer", 0],
        ["sqlite", "writer", 25],
        ["sql.transaction", "writer", 25],
        ["sql.transaction", "reader", 0],
      ]);
    }),
  );
});

it.effect("labels only the span of the statement or transaction that took the lock", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const transaction = sql.withTransaction(sql`SELECT 1`);
    yield* transaction;
    yield* sql.withTransaction(transaction);
    yield* sql`SELECT 2`.pipe(Effect.withTracerEnabled(false));
  }).pipe(
    Effect.withSpan("caller"),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
    Effect.withTracer(tracer),
    Effect.map(() => {
      assert.deepStrictEqual(
        spans
          .filter((span) => span.name === "caller" || span.name === "sql.transaction")
          .map((span) => [span.name, span.attributes.get("db.connection")]),
        [
          ["caller", undefined],
          ["sql.transaction", "writer"],
          ["sql.transaction", "writer"],
          ["sql.transaction", undefined],
        ],
      );
    }),
  );
});

it.effect("keeps large parameters off the reader worker's cached statements", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const read = (value: string) =>
        sql<{ size: number }>`SELECT length(${value}) AS size`.pipe(
          Effect.map((rows) => rows[0]?.size),
        );
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const cached: Array<boolean> = [];
      const postMessage = worker.postMessage;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(worker, "postMessage").mockImplementation(function (
            this: NodeWorkerThreads.Worker,
            message: { readonly cached: boolean },
          ) {
            cached.push(message.cached);
            return postMessage.call(this, message);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );

      assert.equal(yield* read("small").pipe(SqliteClient.readOnly), 5);
      assert.equal(yield* read(largeText).pipe(SqliteClient.readOnly), largeText.length);
      assert.deepEqual(cached, [true, false]);
    }).pipe(Effect.scoped),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

it.effect("uses the writer for read-only work on an in-memory database", () =>
  Effect.gen(function* () {
    const startedBefore = startedWorkers.length;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE memory_entries(name TEXT NOT NULL)`;
    yield* sql`INSERT INTO memory_entries VALUES ('kept')`;

    const rows = yield* sql
      .withTransaction(sql<{ name: string }>`SELECT name FROM memory_entries`)
      .pipe(SqliteClient.readOnly);

    assert.deepEqual(rows, [{ name: "kept" }]);
    assert.equal(startedWorkers.length, startedBefore);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", readerWorker: true }))),
);

it.effect("keeps a nested transaction inside a read-only transaction on the reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const outer = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            yield* Fiber.join(writer);
            const nested = yield* sql.withTransaction(countEntries(sql));
            return { outer, nested };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { outer: 1, nested: 1 });
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("uses the writer for a database that is not in WAL mode", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      const startedBefore = startedWorkers.length;

      yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('on the writer')`)
        .pipe(SqliteClient.readOnly);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const silently = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      silentWorkers.on = true;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        silentWorkers.on = false;
        silentWorkers.readyOnTerminate = false;
      }),
  );

it.effect("turns the reader off when its worker never opens the database", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.equal(read, 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("lets a read be cancelled while its worker is still starting", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(fiber);
        }),
      );

      const next = yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Fiber.join(next), 0);
    }),
  ),
);

it.effect("logs one warning when concurrent first reads find the reader unavailable", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      const counts = yield* Effect.all(
        [
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(counts, [0, 0]);
      assert.equal(startedWorkers.length, startedBefore + 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not hand out a worker that reports ready after another read timed it out", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = () => sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
      const counts = yield* silently(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          const second = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          silentWorkers.readyOnTerminate = true;
          yield* TestClock.adjust("5 seconds");
          return [yield* Fiber.join(first), yield* Fiber.join(second)];
        }),
      );

      assert.deepEqual(counts, [1, 1]);
    }),
  ),
);

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
  options: { readonly readerWorker?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const supportsNoopCheckpoint = (() => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const version = String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
  db.close();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 51);
})();

const checkpointWorkerReply = (worker: NodeWorkerThreads.Worker) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        let replies = 0;
        const onReply = (reply: unknown) => {
          if (reply !== "barrier") return;
          if (++replies < 2) {
            // One checkpoint response may queue a coalesced follow-up behind the first barrier.
            // A second barrier observes that follow-up and makes the helper deterministic.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            worker.postMessage("barrier");
            return;
          }
          worker.off("message", onReply);
          resolve();
        };
        worker.on("message", onReply);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
      }),
  );

const waitForCheckpointMessage = (worker: NodeWorkerThreads.Worker, id: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "id" in message &&
        message.id === id
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const waitForWorkerMessage = (worker: NodeWorkerThreads.Worker, type: string) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === type
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const holdWorkerMessage = (worker: NodeWorkerThreads.Worker, type: string) => {
  const emit = worker.emit.bind(worker) as (
    eventName: string | symbol,
    ...args: unknown[]
  ) => boolean;
  let held: unknown;
  let resolve: (message: unknown) => void = () => {};
  const ready = new Promise<unknown>((done) => {
    resolve = done;
  });
  const spy = vi.spyOn(worker, "emit").mockImplementation((eventName, ...args) => {
    const message = args[0];
    if (
      eventName === "message" &&
      held === undefined &&
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === type
    ) {
      held = message;
      resolve(message);
      return true;
    }
    return emit(eventName, ...args);
  });
  return {
    ready,
    deliver() {
      spy.mockRestore();
      if (held !== undefined) emit("message", held);
    },
    release() {
      spy.mockRestore();
      if (held !== undefined) emit("message", held);
    },
  };
};

const schedulerPausedWhen = (shouldPause: () => boolean) => {
  let yielded = false;
  let pauseNextTask = false;
  let resumeTask: (() => void) | undefined;
  let resolvePaused: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    resolvePaused = resolve;
  });
  const mixed = new Scheduler.MixedScheduler("async", (task) => {
    if (pauseNextTask) {
      pauseNextTask = false;
      resumeTask = task;
      resolvePaused();
      return () => {
        if (resumeTask === task) resumeTask = undefined;
      };
    }
    const immediate = setImmediate(task);
    return () => clearImmediate(immediate);
  });
  const scheduler: Scheduler.Scheduler = {
    executionMode: mixed.executionMode,
    makeDispatcher: () => mixed.makeDispatcher(),
    shouldYield: () => {
      if (!yielded && shouldPause()) {
        yielded = true;
        pauseNextTask = true;
        return true;
      }
      return false;
    },
  };
  return {
    scheduler,
    paused,
    resume() {
      const task = resumeTask;
      resumeTask = undefined;
      task?.();
    },
  };
};

const schedulerPausedBefore = (operation: number) => {
  let operations = 0;
  return schedulerPausedWhen(() => ++operations === operation);
};

const observeWriterWaiters = (worker: NodeWorkerThreads.Worker, count: number) => {
  let seen = 0;
  let resolve: () => void = () => {};
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const ref = worker.ref;
  const spy = vi.spyOn(worker, "ref").mockImplementation(function (this: NodeWorkerThreads.Worker) {
    const result = ref.call(this);
    if (++seen === count) resolve();
    return result;
  });
  return { ready, restore: () => spy.mockRestore() };
};

const pauseCheckpointRequests = (worker: NodeWorkerThreads.Worker) => {
  const queued: Array<Parameters<typeof worker.postMessage>> = [];
  const send = worker.postMessage.bind(worker);
  const spy = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
    queued.push(args);
  });
  let restored = false;
  return {
    queued,
    sendNext() {
      const args = queued.shift();
      if (args !== undefined) send(...args);
      return args?.[0];
    },
    release() {
      if (restored) return;
      restored = true;
      spy.mockRestore();
      for (const args of queued.splice(0)) send(...args);
    },
  };
};

const readCheckpointState = (db: NodeSqlite.DatabaseSync) => {
  const state = db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
  if (typeof state?.log !== "number" || typeof state.checkpointed !== "number") {
    throw new Error("SQLite returned invalid WAL checkpoint frame counts");
  }
  return { log: state.log, checkpointed: state.checkpointed };
};

it.effect.skipIf(!supportsNoopCheckpoint)(
  "keeps one authorizer installed across prepare and automatic reprepare",
  () => {
    const authorizer = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "setAuthorizer");
    return withCheckpointClient((sql) =>
      Effect.gen(function* () {
        yield* sql.unsafe("CREATE TABLE entries(value TEXT NOT NULL)").unprepared;
        yield* sql.unsafe("INSERT INTO entries VALUES ('kept')").unprepared;
        const select = sql<{ readonly value: string }>`SELECT value FROM entries`;
        assert.deepEqual(yield* select, [{ value: "kept" }]);
        yield* sql.unsafe("ALTER TABLE entries ADD COLUMN extra TEXT").unprepared;
        assert.deepEqual(yield* select, [{ value: "kept" }]);
        yield* sql.unsafe("SELECT 1 AS one").unprepared;
        yield* sql.unsafe("SELECT 2 AS two").unprepared;
        assert.equal(authorizer.mock.calls.length, 1);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => authorizer.mockRestore())));
  },
);

it.effect("checkpoints the WAL on the worker instead of the writer", () =>
  withCheckpointClient((sql, filename) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const walSize = Effect.map(fs.stat(`${filename}-wal`), (info) => Number(info.size));
      const worker = startedWorkers.at(-1)!;
      const checkpointRequests = pauseCheckpointRequests(worker);
      yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
      const limit = 1024 * 1024;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`);
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 0);

      // About 1200 frames, past the 1000 that start a checkpoint.
      yield* sql`CREATE TABLE pages(payload BLOB)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
      `;
      const pending = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAbove(pending[0]!.log, 1000);
      assert.isBelow(pending[0]!.checkpointed, pending[0]!.log);
      checkpointRequests.release();
      yield* checkpointWorkerReply(worker);
      const wal = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAtMost(wal[0]!.log - wal[0]!.checkpointed, 1000);

      assert.isAtMost(yield* walSize, limit);
      yield* sql`INSERT INTO pages(payload) VALUES (x'00')`;
      assert.isAtMost(yield* walSize, limit);
    }),
  ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "pauses writer admission before the checkpoint worker truncates the WAL",
  () =>
    withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const worker = startedWorkers.at(-1)!;
          const truncateRequested = waitForWorkerMessage(worker, "truncate-request");
          const truncateStarted = waitForWorkerMessage(worker, "truncate-start");
          const checkpointRequests = pauseCheckpointRequests(worker);
          yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));

          const walLimit = 1024 * 1024;
          yield* sql.unsafe(`PRAGMA journal_size_limit = ${walLimit}`).unprepared;
          yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;
          yield* sql.unsafe(`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
            INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
          `).unprepared;
          const request = checkpointRequests.queued[0]?.[0];
          assert(typeof request === "object" && request !== null && "id" in request);

          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (database) => Effect.sync(() => database.close()),
          );
          reader.exec("BEGIN");
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 6000);

          const requestId = (request as { readonly id: unknown }).id;
          const truncateFinished = waitForCheckpointMessage(worker, requestId);
          checkpointRequests.sendNext();
          checkpointRequests.release();
          const truncate = yield* Effect.promise(() => truncateRequested);
          assert.isBelow(truncate.log as number, 10_000);
          assert.equal(truncate.checkpointed, truncate.log);
          yield* Effect.promise(() => truncateStarted);

          const writerWaiter = observeWriterWaiters(worker, 1);
          const insertStarted = yield* Deferred.make<void>();
          const inserted = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.succeed(insertStarted, undefined);
              yield* sql.unsafe("INSERT INTO pages(payload) VALUES (x'00')").unprepared;
              yield* Deferred.succeed(inserted, undefined);
            }),
            { startImmediately: true },
          );
          yield* Deferred.await(insertStarted);
          yield* Effect.promise(() => writerWaiter.ready);
          writerWaiter.restore();

          let resolveRead: (count: number) => void = () => {};
          const readReply = new Promise<number>((resolve) => {
            resolveRead = resolve;
          });
          yield* Effect.forkChild(
            sql
              .withTransaction(sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM pages`)
              .pipe(
                SqliteClient.readOnly,
                Effect.tap((rows) => Effect.sync(() => resolveRead(rows[0]?.count ?? -1))),
              ),
            { startImmediately: true },
          );
          const first = yield* Effect.promise(() =>
            Promise.race([
              readReply.then((count) => ({ type: "read", count })),
              truncateFinished.then(() => ({ type: "truncate" as const })),
            ]),
          );
          assert.deepEqual(first, { type: "read", count: 6000 });
          assert.equal(yield* Deferred.isDone(inserted), false);

          reader.exec("ROLLBACK");
          yield* Effect.promise(() => truncateFinished);
          yield* Deferred.await(inserted);
          assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), walLimit);
        }),
      { readerWorker: true },
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "resumes queued writes through the scheduler one at a time",
  () =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const truncateRequested = waitForWorkerMessage(worker, "truncate-request");
        const truncateStarted = waitForWorkerMessage(worker, "truncate-start");
        const checkpointRequests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));

        yield* sql.unsafe("PRAGMA journal_size_limit = 1048576").unprepared;
        yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;
        yield* sql.unsafe("CREATE TABLE waited_writes(value INTEGER PRIMARY KEY)").unprepared;
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
          INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
        `).unprepared;
        const request = checkpointRequests.queued[0]?.[0];
        assert(typeof request === "object" && request !== null && "id" in request);

        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        reader.exec("BEGIN");
        assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 6000);
        const requestId = (request as { readonly id: unknown }).id;
        const truncateFinished = waitForCheckpointMessage(worker, requestId);
        checkpointRequests.sendNext();
        checkpointRequests.release();
        const truncate = yield* Effect.promise(() => truncateRequested);
        assert.isBelow(truncate.log as number, 10_000);
        assert.equal(truncate.checkpointed, truncate.log);
        yield* Effect.promise(() => truncateStarted);

        let completedWrites = 0;
        let writesInDispatch = 0;
        let maxWritesInDispatch = 0;
        let schedulerDispatching = false;
        let inUnblockingMessage = false;
        let writesInWorkerMessage = 0;
        let writesOutsideScheduler = 0;
        let heartbeatScheduled = false;
        let resolveHeartbeat: (completed: number) => void = () => {};
        const heartbeat = new Promise<number>((resolve) => {
          resolveHeartbeat = resolve;
        });
        const immediateScheduler = new Scheduler.MixedScheduler("async", (task) => {
          const handle = setImmediate(() => {
            schedulerDispatching = true;
            writesInDispatch = 0;
            try {
              task();
            } finally {
              maxWritesInDispatch = Math.max(maxWritesInDispatch, writesInDispatch);
              schedulerDispatching = false;
            }
          });
          return () => clearImmediate(handle);
        });
        const writeScheduler: Scheduler.Scheduler = {
          executionMode: immediateScheduler.executionMode,
          makeDispatcher: () => immediateScheduler.makeDispatcher(),
          shouldYield: () => false,
        };
        const originalRun = NodeSqlite.StatementSync.prototype.run;
        const runSpy = vi
          .spyOn(NodeSqlite.StatementSync.prototype, "run")
          .mockImplementation(function (this: NodeSqlite.StatementSync, ...params) {
            if (this.sourceSQL.includes("INSERT INTO waited_writes")) {
              if (inUnblockingMessage) writesInWorkerMessage++;
              if (!schedulerDispatching) writesOutsideScheduler++;
              else writesInDispatch++;
            }
            return originalRun.apply(this, params);
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => runSpy.mockRestore()));

        const originalEmit = worker.emit.bind(worker) as (
          eventName: string | symbol,
          ...args: unknown[]
        ) => boolean;
        const emitSpy = vi.spyOn(worker, "emit").mockImplementation((eventName, ...args) => {
          const message = args[0];
          const unblocksWriter =
            eventName === "message" &&
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "checkpoint" &&
            "truncateId" in message &&
            typeof message.truncateId === "number" &&
            "blocked" in message &&
            message.blocked === false;
          if (!unblocksWriter || heartbeatScheduled) return originalEmit(eventName, ...args);

          inUnblockingMessage = true;
          try {
            const result = originalEmit(eventName, ...args);
            heartbeatScheduled = true;
            setImmediate(() => resolveHeartbeat(completedWrites));
            return result;
          } finally {
            inUnblockingMessage = false;
          }
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => emitSpy.mockRestore()));

        const waiterCount = 40;
        const writerWaiters = observeWriterWaiters(worker, waiterCount);
        yield* Effect.addFinalizer(() => Effect.sync(writerWaiters.restore));
        const writeFibers = [];
        for (let value = 0; value < waiterCount; value++) {
          writeFibers.push(
            yield* Effect.forkChild(
              sql.unsafe(`INSERT INTO waited_writes VALUES (${value})`).unprepared.pipe(
                Effect.provideService(Scheduler.Scheduler, writeScheduler),
                Effect.tap(() => Effect.sync(() => completedWrites++)),
              ),
              { startImmediately: true },
            ),
          );
        }
        yield* Effect.promise(() => writerWaiters.ready);

        reader.exec("ROLLBACK");
        yield* Effect.promise(() => truncateFinished);
        const writesAtHeartbeat = yield* Effect.promise(() => heartbeat);
        assert.isAbove(writesAtHeartbeat, 0);
        assert.isBelow(writesAtHeartbeat, waiterCount);
        assert.equal(writesInWorkerMessage, 0);
        assert.equal(writesOutsideScheduler, 0);

        for (const fiber of writeFibers) yield* Fiber.join(fiber);
        assert.equal(completedWrites, waiterCount);
        assert.equal(maxWritesInDispatch, 1);
      }),
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "rechecks admission after the scheduler yields before a write",
  () =>
    withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
          yield* sql.unsafe("CREATE TABLE entries(value INTEGER PRIMARY KEY)").unprepared;
          yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;

          const insert = (value: number) => sql`INSERT INTO entries VALUES (${value})`;
          yield* insert(1);
          let operations = 0;
          let runAt = 0;
          const originalRun = NodeSqlite.StatementSync.prototype.run;
          const runSpy = vi
            .spyOn(NodeSqlite.StatementSync.prototype, "run")
            .mockImplementation(function (this: NodeSqlite.StatementSync, ...params) {
              if (String(params[0]) === "2") runAt = operations;
              return originalRun.apply(this, params);
            });
          yield* Effect.addFinalizer(() => Effect.sync(() => runSpy.mockRestore()));
          const measurementBase = new Scheduler.MixedScheduler();
          const measurementScheduler: Scheduler.Scheduler = {
            executionMode: measurementBase.executionMode,
            makeDispatcher: () => measurementBase.makeDispatcher(),
            shouldYield: () => {
              operations++;
              return false;
            },
          };
          const measuredWrite = yield* Effect.forkChild(
            insert(2).pipe(Effect.provideService(Scheduler.Scheduler, measurementScheduler)),
            { startImmediately: true },
          );
          yield* Fiber.join(measuredWrite);
          assert.isAbove(runAt, 0);

          yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
          const checkpointRequests = pauseCheckpointRequests(worker);
          yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
          yield* sql.unsafe(`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
            INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
          `).unprepared;
          const checkRequest = checkpointRequests.queued[0]?.[0];
          assert(typeof checkRequest === "object" && checkRequest !== null && "id" in checkRequest);

          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (database) => Effect.sync(() => database.close()),
          );
          reader.exec("BEGIN");
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 6000);

          const truncateRequest = holdWorkerMessage(worker, "truncate-request");
          yield* Effect.addFinalizer(() => Effect.sync(truncateRequest.release));
          const truncateStarted = waitForWorkerMessage(worker, "truncate-start");
          const checkId = (checkRequest as { readonly id: unknown }).id;
          const truncateFinished = waitForCheckpointMessage(worker, checkId);
          checkpointRequests.sendNext();
          checkpointRequests.release();
          yield* Effect.promise(() => truncateRequest.ready);

          const controlled = schedulerPausedBefore(runAt);
          const writerWaiter = observeWriterWaiters(worker, 1);
          yield* Effect.addFinalizer(() => Effect.sync(writerWaiter.restore));
          const writeFiber = yield* Effect.forkChild(
            insert(3).pipe(Effect.provideService(Scheduler.Scheduler, controlled.scheduler)),
            { startImmediately: true },
          );
          yield* Effect.promise(() => controlled.paused);
          assert.isUndefined(writeFiber.pollUnsafe());

          truncateRequest.deliver();
          yield* Effect.promise(() => truncateStarted);
          controlled.resume();
          const admission = yield* Effect.race(
            Effect.as(
              Effect.promise(() => writerWaiter.ready),
              "blocked" as const,
            ),
            Effect.as(Fiber.await(writeFiber), "executed" as const),
          );
          assert.equal(admission, "blocked");
          assert.isUndefined(writeFiber.pollUnsafe());

          const rows = yield* sql
            .withTransaction(sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM pages`)
            .pipe(SqliteClient.readOnly);
          assert.equal(rows[0]?.count, 6000);
          assert.isUndefined(writeFiber.pollUnsafe());

          reader.exec("ROLLBACK");
          yield* Effect.promise(() => truncateFinished);
          checkpointRequests.release();
          yield* Fiber.join(writeFiber);
          yield* checkpointWorkerReply(worker);
          assert.deepEqual(yield* sql`SELECT value FROM entries ORDER BY value`.values, [
            [1],
            [2],
            [3],
          ]);
        }),
      { readerWorker: true },
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "keeps transaction admission masked until BEGIN has a rollback handler",
  () =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        yield* sql.unsafe("CREATE TABLE transaction_writes(value INTEGER PRIMARY KEY)").unprepared;
        const seed = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        let beginExecuted = false;
        const originalRun = NodeSqlite.StatementSync.prototype.run;
        const runSpy = vi
          .spyOn(NodeSqlite.StatementSync.prototype, "run")
          .mockImplementation(function (this: NodeSqlite.StatementSync, ...params) {
            const result = originalRun.apply(this, params);
            if (/^\s*BEGIN\b/i.test(this.sourceSQL)) beginExecuted = true;
            return result;
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => runSpy.mockRestore()));

        const controlled = schedulerPausedWhen(() => beginExecuted);
        const transactionFiber = yield* Effect.forkChild(
          sql
            .withTransaction(sql`INSERT INTO transaction_writes VALUES (1)`)
            .pipe(Effect.provideService(Scheduler.Scheduler, controlled.scheduler)),
          { startImmediately: true },
        );
        yield* Effect.promise(() => controlled.paused);
        assert.isTrue(beginExecuted);
        assert.isUndefined(transactionFiber.pollUnsafe());

        const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(transactionFiber), {
          startImmediately: true,
        });
        controlled.resume();
        yield* Fiber.join(interruptFiber);
        assert.equal((yield* Fiber.await(transactionFiber))._tag, "Failure");

        yield* sql.unsafe("INSERT INTO transaction_writes VALUES (2)").unprepared;
        assert.deepEqual(
          seed.prepare("SELECT value FROM transaction_writes ORDER BY value").all(),
          [{ value: 2 }],
        );
      }),
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "ignores a delayed idle checkpoint snapshot after newer writer frames",
  () =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        yield* sql.unsafe("PRAGMA journal_size_limit = -1").unprepared;
        yield* sql.unsafe("CREATE TABLE entries(id INTEGER PRIMARY KEY, payload BLOB)").unprepared;

        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM entries").get();

        const idleSnapshotPromise = waitForCheckpointMessage(worker, undefined);
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
          INSERT INTO entries(id, payload) SELECT i, randomblob(4000) FROM n
        `).unprepared;
        const idleSnapshot = yield* Effect.promise(() => idleSnapshotPromise);
        assert.equal(idleSnapshot.id, undefined);
        assert.isBelow(idleSnapshot.log as number, 10_000);

        const checkpointRequests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12_000)
          INSERT INTO entries(id, payload) SELECT 1200 + i, randomblob(4000) FROM n
        `).unprepared;
        const freshRequest = checkpointRequests.queued.find(
          ([request]) =>
            typeof request === "object" &&
            request !== null &&
            "type" in request &&
            request.type === "check",
        )?.[0];
        assert(
          typeof freshRequest === "object" && freshRequest !== null && "generation" in freshRequest,
        );
        assert.isAbove(
          (freshRequest as { readonly generation: number }).generation,
          idleSnapshot.generation as number,
        );

        worker.emit("message", idleSnapshot);
        const writeFinished = yield* Deferred.make<void>();
        const writerWaiter = observeWriterWaiters(worker, 1);
        yield* Effect.addFinalizer(() => Effect.sync(writerWaiter.restore));
        yield* Effect.forkChild(
          sql
            .unsafe("INSERT INTO entries VALUES (13201, x'00')")
            .unprepared.pipe(Effect.tap(() => Deferred.succeed(writeFinished, undefined))),
          { startImmediately: true },
        );
        const admission = yield* Effect.race(
          Effect.as(
            Effect.promise(() => writerWaiter.ready),
            "blocked" as const,
          ),
          Effect.as(Deferred.await(writeFinished), "executed" as const),
        );
        assert.equal(admission, "blocked");
        assert.isFalse(yield* Deferred.isDone(writeFinished));

        reader.exec("ROLLBACK");
        checkpointRequests.release();
        yield* Deferred.await(writeFinished);
        yield* checkpointWorkerReply(worker);
        assert.equal(
          (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`)[0]?.count,
          13_201,
        );
      }),
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "cancels blocked transaction admission and rechecks queued writes before execution",
  () =>
    withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
          yield* sql.unsafe("CREATE TABLE entries(value INTEGER PRIMARY KEY)").unprepared;
          yield* sql.unsafe("INSERT INTO entries VALUES (0)").unprepared;
          yield* sql.unsafe("CREATE TABLE batch_pages(id INTEGER PRIMARY KEY, payload BLOB)")
            .unprepared;
          const seed = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (database) => Effect.sync(() => database.close()),
          );

          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (database) => Effect.sync(() => database.close()),
          );
          reader.exec("BEGIN");
          reader.prepare("SELECT COUNT(*) FROM entries").get();
          const checkpointRequests = pauseCheckpointRequests(worker);
          yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
          yield* sql.unsafe(`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
            INSERT INTO batch_pages(id, payload)
            SELECT 20_000 + i, randomblob(4000) FROM n
          `).unprepared;
          const initialRequest = checkpointRequests.queued[0]?.[0];
          assert(
            typeof initialRequest === "object" && initialRequest !== null && "id" in initialRequest,
          );
          const initialCheckpoint = waitForCheckpointMessage(
            worker,
            (initialRequest as { readonly id: unknown }).id,
          );
          checkpointRequests.sendNext();
          const initialState = yield* Effect.promise(() => initialCheckpoint);
          assert.isTrue(initialState.blocked as boolean);
          assert.isBelow(initialState.log as number, 10_000);
          assert.isAbove((initialState.log as number) - (initialState.checkpointed as number), 0);

          const transactionBody = yield* Deferred.make<void>();
          const cancelledWaiter = observeWriterWaiters(worker, 1);
          const cancelled = yield* Effect.forkChild(
            sql.withTransaction(Deferred.succeed(transactionBody, undefined)),
            { startImmediately: true },
          );
          yield* Effect.promise(() => cancelledWaiter.ready);
          cancelledWaiter.restore();
          yield* Fiber.interrupt(cancelled);
          assert.isFalse(yield* Deferred.isDone(transactionBody));

          const cancellationRequest = checkpointRequests.queued[0]?.[0];
          assert(
            typeof cancellationRequest === "object" &&
              cancellationRequest !== null &&
              "id" in cancellationRequest,
          );
          const cancellationReply = waitForCheckpointMessage(
            worker,
            (cancellationRequest as { readonly id: unknown }).id,
          );
          checkpointRequests.sendNext();
          yield* Effect.promise(() => cancellationReply);

          // Leave the reader snapshot in place, but remove the artificial size-limit block.
          // Below 10,000 frames the worker can now admit one statement while preserving that snapshot.
          yield* sql.unsafe("PRAGMA journal_size_limit = -1").unprepared;

          const largeDone = yield* Deferred.make<void>();
          const largeWaiter = observeWriterWaiters(worker, 1);
          yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* sql.unsafe(`
                WITH RECURSIVE n(i) AS (
                  SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000
                )
                INSERT INTO batch_pages(id, payload) SELECT i, randomblob(4000) FROM n
              `).unprepared;
              yield* Deferred.succeed(largeDone, undefined);
            }),
            { startImmediately: true },
          );
          yield* Effect.promise(() => largeWaiter.ready);
          largeWaiter.restore();

          const smallDone = yield* Deferred.make<void>();
          const smallWaiter = observeWriterWaiters(worker, 1);
          yield* Effect.forkChild(
            sql
              .unsafe("INSERT INTO entries VALUES (1)")
              .unprepared.pipe(Effect.tap(() => Deferred.succeed(smallDone, undefined))),
            { startImmediately: true },
          );
          yield* Effect.promise(() => smallWaiter.ready);
          smallWaiter.restore();

          const firstRequest = checkpointRequests.queued[0]?.[0];
          assert(typeof firstRequest === "object" && firstRequest !== null && "id" in firstRequest);
          const staleUnblock = waitForCheckpointMessage(
            worker,
            (firstRequest as { readonly id: unknown }).id,
          );
          checkpointRequests.sendNext();
          yield* Effect.promise(() => staleUnblock);
          const followUpRequest = checkpointRequests.queued[0]?.[0];
          assert(
            typeof followUpRequest === "object" &&
              followUpRequest !== null &&
              "id" in followUpRequest,
          );
          const initialUnblock = waitForCheckpointMessage(
            worker,
            (followUpRequest as { readonly id: unknown }).id,
          );
          checkpointRequests.sendNext();
          const unblockedState = yield* Effect.promise(() => initialUnblock);
          assert.isFalse(unblockedState.blocked as boolean);
          assert.isBelow(unblockedState.log as number, 10_000);

          yield* Deferred.await(largeDone);
          const frames = readCheckpointState(seed);
          assert.isAtLeast(frames.log, 10_000);
          assert.isAbove(frames.log - frames.checkpointed, 10_000);
          assert.deepEqual(yield* sql.unsafe("PRAGMA journal_mode").unprepared, [
            { journal_mode: "wal" },
          ]);

          let resolveRead: (count: number) => void = () => {};
          const readReply = new Promise<number>((resolve) => {
            resolveRead = resolve;
          });
          yield* Effect.forkChild(
            sql
              .withTransaction(
                sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`,
              )
              .pipe(
                SqliteClient.readOnly,
                Effect.tap((rows) => Effect.sync(() => resolveRead(rows[0]?.count ?? -1))),
              ),
            { startImmediately: true },
          );
          assert.equal(yield* Effect.promise(() => readReply), 1);
          assert.isFalse(yield* Deferred.isDone(smallDone));

          reader.exec("ROLLBACK");
          checkpointRequests.release();
          yield* checkpointWorkerReply(worker);
          yield* Deferred.await(smallDone);
          yield* checkpointWorkerReply(worker);

          // A new transaction also proves the cancelled BEGIN released the writer semaphore.
          yield* sql.withTransaction(sql`SELECT 1`);
        }),
      { readerWorker: true },
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "gates incremental vacuum while allowing read-only PRAGMAs",
  () =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
        yield* sql.unsafe("PRAGMA auto_vacuum = INCREMENTAL").unprepared;
        yield* sql.unsafe("VACUUM").unprepared;
        yield* sql.unsafe("CREATE TABLE entries(value INTEGER PRIMARY KEY)").unprepared;
        yield* sql.unsafe("CREATE TABLE reclaim_pages(payload BLOB)").unprepared;
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
          INSERT INTO reclaim_pages(payload) SELECT randomblob(4000) FROM n
        `).unprepared;
        yield* sql.unsafe("DELETE FROM reclaim_pages").unprepared;
        const seed = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        assert.equal(seed.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum, 2);
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM entries").get();
        const checkpointRequests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
          INSERT INTO reclaim_pages(payload) SELECT randomblob(4000) FROM n
        `).unprepared;
        yield* sql.unsafe("DELETE FROM reclaim_pages").unprepared;
        const pagesBefore = seed.prepare("PRAGMA page_count").get()?.page_count;
        const freeBefore = seed.prepare("PRAGMA freelist_count").get()?.freelist_count as number;
        assert.isAbove(freeBefore, 0);
        const initialRequest = checkpointRequests.queued[0]?.[0];
        assert(
          typeof initialRequest === "object" && initialRequest !== null && "id" in initialRequest,
        );
        const firstCheckpoint = waitForCheckpointMessage(
          worker,
          (initialRequest as { readonly id: unknown }).id,
        );
        checkpointRequests.sendNext();
        yield* Effect.promise(() => firstCheckpoint);
        const followUpRequest = checkpointRequests.queued[0]?.[0];
        assert(
          typeof followUpRequest === "object" &&
            followUpRequest !== null &&
            "id" in followUpRequest,
        );
        const initialCheckpoint = waitForCheckpointMessage(
          worker,
          (followUpRequest as { readonly id: unknown }).id,
        );
        checkpointRequests.sendNext();
        const initialState = yield* Effect.promise(() => initialCheckpoint);
        assert.isTrue(initialState.blocked as boolean);
        yield* sql.unsafe("PRAGMA journal_size_limit = -1").unprepared;

        let resolveVacuum: () => void = () => {};
        const vacuumFinished = new Promise<void>((resolve) => {
          resolveVacuum = resolve;
        });
        const waiter = observeWriterWaiters(worker, 1);
        yield* Effect.forkChild(
          sql
            .unsafe("PRAGMA incremental_vacuum(1)")
            .unprepared.pipe(Effect.tap(() => Effect.sync(resolveVacuum))),
          { startImmediately: true },
        );
        const admission = yield* Effect.promise(() =>
          Promise.race([
            waiter.ready.then(() => "blocked" as const),
            vacuumFinished.then(() => "completed" as const),
          ]),
        );
        assert.equal(admission, "blocked");
        waiter.restore();
        assert.deepEqual(yield* sql.unsafe("PRAGMA journal_mode").unprepared, [
          { journal_mode: "wal" },
        ]);

        reader.exec("ROLLBACK");
        checkpointRequests.release();
        yield* checkpointWorkerReply(worker);
        yield* Effect.promise(() => vacuumFinished);
        yield* checkpointWorkerReply(worker);
        const pagesAfter = seed.prepare("PRAGMA page_count").get()?.page_count;
        const freeAfter = seed.prepare("PRAGMA freelist_count").get()?.freelist_count as number;
        assert.isAtMost(pagesAfter as number, pagesBefore as number);
        assert.isBelow(freeAfter, freeBefore);
      }),
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "accounts partial writes from a failed OR FAIL statement before admitting another writer",
  () =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
        yield* sql.unsafe("CREATE TABLE entries(id INTEGER PRIMARY KEY, payload BLOB)").unprepared;
        yield* sql.unsafe("INSERT INTO entries VALUES (12001, x'00')").unprepared;
        const seed = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (database) => Effect.sync(() => database.close()),
        );
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM entries").get();

        const checkpointRequests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
        const failure = yield* Effect.flip(
          sql.unsafe(`
            WITH RECURSIVE n(i) AS (
              SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12001
            )
            INSERT OR FAIL INTO entries(id, payload)
            SELECT i, randomblob(4000) FROM n ORDER BY i
          `).unprepared,
        );
        assert.equal(failure._tag, "SqlError");
        assert.equal(
          (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`)[0]?.count,
          12_001,
        );
        const frames = readCheckpointState(seed);
        assert.isAtLeast(frames.log, 10_000);
        assert.isAbove(frames.log - frames.checkpointed, 0);

        const attemptedCheck = checkpointRequests.queued[0]?.[0];
        assert(
          typeof attemptedCheck === "object" &&
            attemptedCheck !== null &&
            "force" in attemptedCheck,
        );
        assert.isTrue((attemptedCheck as { readonly force: boolean }).force);

        let resolveInserted: () => void = () => {};
        const insertFinished = new Promise<void>((resolve) => {
          resolveInserted = resolve;
        });
        const waiter = observeWriterWaiters(worker, 1);
        yield* Effect.forkChild(
          sql
            .unsafe("INSERT INTO entries VALUES (12002, x'01')")
            .unprepared.pipe(Effect.tap(() => Effect.sync(resolveInserted))),
          { startImmediately: true },
        );
        const admission = yield* Effect.promise(() =>
          Promise.race([
            waiter.ready.then(() => "backpressured" as const),
            insertFinished.then(() => "executed" as const),
          ]),
        );
        assert.equal(admission, "backpressured");
        waiter.restore();

        reader.exec("ROLLBACK");
        checkpointRequests.release();
        yield* checkpointWorkerReply(worker);
        yield* Effect.promise(() => insertFinished);
        assert.equal(
          (yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`)[0]?.count,
          12_002,
        );
      }),
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "backpressures writes at transaction boundaries while reads stay available",
  () =>
    withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const walLimit = 1024 * 1024;
          const worker = startedWorkers.at(-1)!;
          const checkpointRequests = pauseCheckpointRequests(worker);
          yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
          yield* sql.unsafe(`PRAGMA journal_size_limit = ${walLimit}`).unprepared;
          const seed = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (db) => Effect.sync(() => db.close()),
          );
          seed.exec(
            `PRAGMA synchronous = NORMAL;
             PRAGMA checkpoint_fullfsync = ON;
             PRAGMA wal_autocheckpoint = 0;`,
          );
          yield* sql.unsafe(`
            CREATE TABLE orchestration_events (
              sequence INTEGER PRIMARY KEY,
              aggregate_kind TEXT NOT NULL,
              stream_id TEXT NOT NULL,
              event_json BLOB NOT NULL
            )
          `).unprepared;
          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
            (db) => Effect.sync(() => db.close()),
          );
          reader.exec("BEGIN");
          reader.prepare("SELECT COUNT(*) FROM orchestration_events").get();

          yield* sql.withTransaction(
            Effect.gen(function* () {
              // SQLite hides uncommitted frames from the checkpoint connection.
              const transactionRead = yield* sql<{
                readonly count: number;
              }>`SELECT COUNT(*) AS count FROM orchestration_events`;
              assert.equal(transactionRead[0]?.count, 0);
              for (let batch = 0; batch < 40; batch++) {
                const firstSequence = 1 + batch * 300;
                yield* sql.unsafe(`
                  WITH RECURSIVE n(i) AS (
                    SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299
                  )
                  INSERT INTO orchestration_events(sequence, aggregate_kind, stream_id, event_json)
                  SELECT ${firstSequence} + i, 'thread', 'fixture', randomblob(4000) FROM n
                `).unprepared;
              }
              assert.isAbove(Number((yield* fs.stat(`${filename}-wal`)).size), 30 * 1024 * 1024);
              yield* sql`
                INSERT INTO orchestration_events
                VALUES (12001, 'thread', 'fixture', x'00')
              `;
            }),
          );

          const startInsert = (sequence: number) =>
            Effect.gen(function* () {
              const started = yield* Deferred.make<void>();
              const inserted = yield* Deferred.make<void>();
              const fiber = yield* Effect.forkChild(
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  yield* sql`
                    INSERT INTO orchestration_events
                    VALUES (${sequence}, 'thread', 'fixture', x'00')
                  `;
                  yield* Deferred.succeed(inserted, undefined);
                }),
              );
              yield* Deferred.await(started);
              return { fiber, inserted };
            });

          const cancelled = yield* startInsert(12_002);
          yield* Effect.yieldNow;
          assert.equal(yield* Deferred.isDone(cancelled.inserted), false);
          yield* Fiber.interrupt(cancelled.fiber);

          const sequences = Array.from({ length: 50 }, (_, index) => index + 1);
          const placeholders = sequences.map(() => "?").join(",");
          const deleteStarted = yield* Deferred.make<void>();
          const deleted = yield* Deferred.make<void>();
          yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.succeed(deleteStarted, undefined);
              yield* sql.unsafe(
                `DELETE FROM orchestration_events WHERE sequence IN (${placeholders})`,
                sequences,
              ).unprepared;
              yield* Deferred.succeed(deleted, undefined);
            }),
          );
          yield* Deferred.await(deleteStarted);
          yield* Effect.yieldNow;
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
          assert.equal(yield* Deferred.isDone(deleted), false);

          checkpointRequests.release();
          yield* checkpointWorkerReply(worker);
          const held = readCheckpointState(seed);
          assert.isAbove(held.log - held.checkpointed, 10_000);
          assert.equal(yield* Deferred.isDone(deleted), false);
          const walBeforeNextWrite = yield* fs.stat(`${filename}-wal`);
          assert.isAbove(Number(walBeforeNextWrite.size), 30 * 1024 * 1024);
          const rows = seed.prepare("SELECT COUNT(*) AS count FROM orchestration_events").get();
          assert.equal(rows?.count, 12_001);

          const readRows = yield* sql
            .withTransaction(
              sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM orchestration_events
              `,
            )
            .pipe(SqliteClient.readOnly);
          assert.equal(readRows[0]?.count, 12_001);

          const readDuringGate = yield* sql
            .withTransaction(
              sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count FROM orchestration_events
              `,
            )
            .pipe(SqliteClient.readOnly);
          assert.equal(readDuringGate[0]?.count, 12_001);

          reader.exec("ROLLBACK");
          yield* checkpointWorkerReply(worker);
          yield* Deferred.await(deleted);
          yield* checkpointWorkerReply(worker);
          const afterDelete = seed
            .prepare("SELECT COUNT(*) AS count FROM orchestration_events")
            .get();
          assert.equal(afterDelete?.count, 11_951);
          const drained = readCheckpointState(seed);
          assert.isAtMost(drained.log - drained.checkpointed, 1000);
          assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), walLimit);

          yield* sql.unsafe("PRAGMA journal_size_limit = -1").unprepared;
          let largestWal = 0;
          let largestWalState = "no WAL samples";
          let workerReplies = 0;
          worker.on("message", (message: unknown) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "checkpoint"
            ) {
              workerReplies++;
            }
          });
          for (let batch = 0; batch < 100; batch++) {
            const firstSequence = 12_003 + batch * 150;
            yield* sql.unsafe(`
              WITH RECURSIVE n(i) AS (
                SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149
              )
              INSERT INTO orchestration_events(sequence, aggregate_kind, stream_id, event_json)
              SELECT ${firstSequence} + i, 'thread', 'fixture', randomblob(4000) FROM n
            `).unprepared;
            const walSize = Number((yield* fs.stat(`${filename}-wal`)).size);
            if (walSize > largestWal) {
              largestWal = walSize;
              const state = readCheckpointState(seed);
              largestWalState = JSON.stringify({
                batch,
                log: state.log,
                checkpointed: state.checkpointed,
                pending: state.log - state.checkpointed,
                workerReplies,
              });
            }
          }
          yield* checkpointWorkerReply(worker);
          const final = readCheckpointState(seed);
          assert.isAtMost(final.log - final.checkpointed, 1000);
          assert.isBelow(largestWal, 50 * 1024 * 1024, largestWalState);
        }),
      { readerWorker: true },
    ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "releases a blocked writer when the checkpoint worker fails",
  () =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        yield* sql.unsafe("CREATE TABLE entries(value BLOB)").unprepared;
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
          (db) => Effect.sync(() => db.close()),
        );
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM entries").get();
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
          INSERT INTO entries(value) SELECT randomblob(4000) FROM n
        `).unprepared;
        yield* checkpointWorkerReply(worker);
        const frames = yield* sql<{
          readonly log: number;
          readonly checkpointed: number;
        }>`PRAGMA wal_checkpoint(NOOP)`;
        assert.isAtLeast(frames[0]!.log, 10_000);
        assert.isAbove(frames[0]!.log - frames[0]!.checkpointed, 0);

        const started = yield* Deferred.make<void>();
        const inserted = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* sql`INSERT INTO entries VALUES (x'00')`;
            yield* Deferred.succeed(inserted, undefined);
          }),
        );
        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        yield* checkpointWorkerReply(worker);
        assert.equal(yield* Deferred.isDone(inserted), false);

        yield* Effect.promise(() => worker.terminate());
        yield* Deferred.await(inserted);
        const autocheckpoint = yield* sql<{
          readonly wal_autocheckpoint: number;
        }>`PRAGMA wal_autocheckpoint`;
        assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
        reader.exec("ROLLBACK");
      }),
    ),
);

it.effect("hands checkpoints back to the writer when the worker stops", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
    }),
  ),
);

it.effect("warns once and hands checkpoints back when the worker fails at startup", () => {
  const { warnings, layer: logs } = captureWarnings();
  const reason = "SQLite 3.50.4 has no NOOP checkpoint";
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      failingWorkers.message = reason;
    }),
    () =>
      withCheckpointClient((sql) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          if (worker.threadId !== -1) {
            yield* Effect.promise(() => new Promise((resolve) => worker.once("exit", resolve)));
          }
          const autocheckpoint = yield* sql<{
            readonly wal_autocheckpoint: number;
          }>`PRAGMA wal_autocheckpoint`;
          assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
          assert.deepEqual(warnings, [
            [
              "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
              { reason },
            ],
          ]);
        }),
      ),
    () =>
      Effect.sync(() => {
        failingWorkers.message = undefined;
      }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not warn when the client stops its checkpoint worker", () => {
  const { warnings, layer: logs } = captureWarnings();
  return Effect.gen(function* () {
    yield* withCheckpointClient(() => Effect.void);
    assert.lengthOf(warnings, 0);
  }).pipe(Effect.provide(logs));
});
