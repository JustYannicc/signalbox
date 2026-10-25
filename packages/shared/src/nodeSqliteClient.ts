import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /**
   * Ignored for in-memory databases, which a second connection cannot share.
   */
  readonly readerWorker?: boolean | undefined;
  readonly readerStartupTimeout?: Duration.Input | undefined;
  /**
   * Ignored for in-memory databases.
   */
  readonly checkpointWorker?: boolean | undefined;
}

const ReadOnly = Context.Reference<boolean>("@t3tools/shared/nodeSqliteClient/ReadOnly", {
  defaultValue: () => false,
});

/**
 * Wrap the whole transaction, as in
 * `sql.withTransaction(reads).pipe(readOnly)`. Inside an open write transaction
 * the reads keep using the writer, and a write attempted on the reader fails
 * with "attempt to write a readonly database".
 */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadOnly, true);

interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}

type SqliteExecutionResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: SqlError };

const sqliteExecutionToEffect = <A>(
  result: SqliteExecutionResult<A>,
): Effect.Effect<A, SqlError> =>
  result._tag === "Success" ? Effect.succeed(result.value) : Effect.fail(result.error);

const annotateAcquired = (fiber: Fiber.Fiber<unknown, unknown>, acquired: Acquired | undefined) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
};

const TransactionAcquire = Context.Reference<
  { acquired?: Acquired; restore: typeof Effect.interruptible | undefined } | undefined
>("@t3tools/shared/nodeSqliteClient/TransactionAcquire", { defaultValue: () => undefined });

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

/**
 * SQLite keeps its copy of a statement's text and blob parameters until the
 * statement is bound again or finalized, and `node:sqlite` cannot clear them.
 */
const LARGE_BINDING_SIZE = 64 * 1024;

const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // `node:sqlite` takes named parameters as one object, callable or not.
        // Read data properties only: calling a getter here would run it twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    return true;
  }
};

// Evaluated source instead of a worker file, so the reader also starts from
// bundles and single-executable builds that have no module file on disk.
const readerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: true,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error) });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", ({ id, sql, params, cached, values, raw, safeIntegers }) => {
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      parentPort.postMessage({ id, rows: statement.all(...params) });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [] });
    }
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

interface ReaderRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type ReaderStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string };

type ReaderReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const readerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// COMMIT, ROLLBACK and ROLLBACK TO SAVEPOINT. On a reader they change nothing,
// so they succeed once the worker is gone instead of failing the cleanup.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

/**
 * Each worker gets its own `Connection`, so a transaction stays on the worker
 * it began on: once that worker exits, its statements fail rather than silently
 * continuing outside the transaction on a replacement.
 */
const makeReader = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<ReaderStartup>;
      }
    | undefined;
  let unavailable = false;
  let nextRequestId = 0;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(readerWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
      },
    });
    let announce: (startup: ReaderStartup) => void = () => {};
    const started = new Promise<ReaderStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      { readonly endsTransaction: boolean; readonly resume: (reply: ReaderReply) => void }
    >();
    const stop = (message: string) => {
      stoppedMessage = message;
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      for (const [id, request] of pending) {
        request.resume(
          request.endsTransaction
            ? { id, rows: [] }
            : { id, error: { operation: "execute", message } },
        );
      }
      pending.clear();
    };
    worker.on("message", (reply: ReaderReply | ReaderStartup) => {
      if ("type" in reply) {
        announce(reply);
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      request.resume(reply);
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.succeed([])
            : Effect.fail(
                failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute"),
              );
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            endsTransaction,
            resume: (reply) => {
              if ("rows" in reply) {
                resume(Effect.succeed(reply.rows));
                return;
              }
              const { operation, message, ...codes } = reply.error;
              resume(
                Effect.fail(
                  failed(
                    Object.assign(new Error(message), codes),
                    readerFailureMessages[operation],
                    operation,
                  ),
                ),
              );
            },
          });
          if (pending.size === 1) worker.ref();
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
        });
      });

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true });
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false });
      },
      executeValuesUnprepared(sql, params) {
        return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
      },
      executeUnprepared(sql, params, rowTransform) {
        // A read-only connection rejects BEGIN IMMEDIATE and BEGIN EXCLUSIVE,
        // and a deferred BEGIN is all a read snapshot needs.
        const statement = /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    current = { worker, connection, started };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await current?.worker.terminate();
    }),
  );

  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );

  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      if (unavailable) return Effect.succeed(undefined);
      unavailable = true;
      return Effect.logWarning("SQLite reader worker unavailable; reads use the main connection", {
        reason,
      }).pipe(Effect.as(undefined));
    });

  return Effect.suspend((): Effect.Effect<Connection | undefined> => {
    if (unavailable) return Effect.succeed(undefined);
    let reader: NonNullable<typeof current>;
    try {
      reader = current ?? start();
    } catch (cause) {
      return turnOff(undefined, String(cause));
    }
    // SqlClient acquires transaction connections uninterruptibly. Waiting for the
    // worker happens before any lock is taken, so let a cancelled request leave.
    return Effect.flatMap(
      Effect.interruptible(
        Effect.timeoutOption(
          Effect.promise(() => reader.started),
          startupTimeout,
        ),
      ),
      (startup): Effect.Effect<Connection | undefined> =>
        // Another acquire may have timed out and retired this worker while this one
        // waited; a late "ready" must not hand out a worker that is being terminated.
        unavailable || current !== reader
          ? Effect.succeed(undefined)
          : Option.isSome(startup) && startup.value.type === "ready"
            ? Effect.succeed(reader.connection)
            : turnOff(
                reader,
                Option.isSome(startup) && startup.value.type === "unavailable"
                  ? startup.value.message
                  : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
              ),
    );
  });
});

const CHECKPOINT_FRAMES = 1000;
// Bound the background-checkpoint window without checkpointing on the writer.
// One statement or transaction can cross it, and a reader can hold writes at the ceiling.
const CHECKPOINT_IDLE_MS = 100;
const CHECKPOINT_BACKPRESSURE_FRAMES = 10 * CHECKPOINT_FRAMES;

const readSafeSqliteInteger = (value: unknown) => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return undefined;
};

// SQLite before 3.51 reads NOOP as PASSIVE and would checkpoint on every
// request, so the worker refuses to start there and the writer keeps
// checkpointing.
const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
let db;
let frames;
let checkpoint;
let truncate;
let journalSizeLimit = -1;
let generation = 0;
let nextTruncateRequestId = 0;
let pendingTruncate;
let pendingBarriers = 0;
const initialize = () => {
  if (db !== undefined) return;
  // Client setup switches the writer to WAL after the client layer starts.
  // Opening this connection earlier can race that mode change and WAL recovery.
  db = new DatabaseSync(workerData.filename);
  // TRUNCATE may wait for readers; the writer is already gated on the main thread.
  db.exec("PRAGMA busy_timeout = 5000;");
  const version = db.prepare("SELECT sqlite_version() AS version").get().version;
  const [major, minor] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 51)) {
    throw new Error("SQLite " + version + " has no NOOP checkpoint");
  }
  const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  // macOS fsync() does not flush the drive cache; F_FULLFSYNC does. Other platforms ignore this.
  db.exec("PRAGMA checkpoint_fullfsync = ON;");
  frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
  checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  truncate = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
};
const pendingFrames = (state) => state.log - state.checkpointed;
const needsBackpressure = (state) =>
  state.log >= workerData.backpressureFrames && state.checkpointed < state.log;
const check = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  initialize();
  if (Number.isSafeInteger(nextGeneration) && nextGeneration > generation) {
    generation = nextGeneration;
  }
  if (pendingTruncate !== undefined) {
    return {
      ...pendingTruncate.state,
      generation: pendingTruncate.generation,
      blocked: true,
      waitingForTruncate: true,
    };
  }
  if (Number.isSafeInteger(nextJournalSizeLimit) && nextJournalSizeLimit !== journalSizeLimit) {
    db.exec("PRAGMA journal_size_limit = " + nextJournalSizeLimit);
    journalSizeLimit = nextJournalSizeLimit;
  }
  let state = frames.get();
  const walSizeLimitExceeded =
    journalSizeLimit >= 0 && statSync(workerData.filename + "-wal").size > journalSizeLimit;
  if (force || pendingFrames(state) >= workerData.frames || walSizeLimitExceeded) {
    checkpoint.get();
    state = frames.get();
  }
  let blocked = needsBackpressure(state) || (walSizeLimitExceeded && state.checkpointed < state.log);
  if (
    state.checkpointed === state.log &&
    (state.log >= workerData.backpressureFrames || walSizeLimitExceeded)
  ) {
    pendingTruncate = {
      truncateId: ++nextTruncateRequestId,
      checkId: id,
      generation,
      state,
    };
    parentPort.postMessage({
      type: "truncate-request",
      truncateId: pendingTruncate.truncateId,
      generation,
      checkId: id,
      ...state,
    });
    return { ...state, blocked: true, waitingForTruncate: true };
  }
  blocked ||= needsBackpressure(state);
  const result = { ...state, blocked };
  parentPort.postMessage({ type: "checkpoint", id, generation, ...result });
  return { ...result, waitingForTruncate: false };
};
const finishTruncate = (truncateId) => {
  if (pendingTruncate === undefined || pendingTruncate.truncateId !== truncateId) return;
  const pending = pendingTruncate;
  parentPort.postMessage({ type: "truncate-start", truncateId });
  let blocked;
  try {
    blocked = truncate.get().busy !== 0;
  } catch {
    blocked = true;
  }
  const state = frames.get();
  const walSizeLimitExceeded =
    journalSizeLimit >= 0 && statSync(workerData.filename + "-wal").size > journalSizeLimit;
  blocked ||= needsBackpressure(state) || walSizeLimitExceeded;
  pendingTruncate = undefined;
  parentPort.postMessage({
    type: "checkpoint",
    id: pending.checkId,
    generation: pending.generation,
    truncateId,
    ...state,
    blocked,
  });
  while (pendingBarriers > 0) {
    pendingBarriers--;
    parentPort.postMessage("barrier");
  }
  if (pendingFrames(state) >= workerData.frames || blocked) {
    idle = setTimeout(finish, workerData.idleMs);
  }
};
const finish = () => {
  const before = frames.get();
  const force = needsBackpressure(before);
  const state = check(undefined, journalSizeLimit, force, generation);
  if (!state.waitingForTruncate && (pendingFrames(state) >= workerData.frames || state.blocked)) {
    idle = setTimeout(finish, workerData.idleMs);
  }
};
let idle;
parentPort.on("message", (request) => {
  clearTimeout(idle);
  if (request && request.type === "truncate") {
    finishTruncate(request.truncateId);
    return;
  }
  const isBarrier = request === "barrier";
  if (pendingTruncate !== undefined) {
    if (isBarrier) pendingBarriers++;
    else if (request && typeof request === "object" && request.type === "check") {
      // Answer the in-flight check without presenting the pending state as a newer snapshot.
      parentPort.postMessage({
        type: "checkpoint",
        id: request.id,
        generation: pendingTruncate.generation,
        ...pendingTruncate.state,
        blocked: true,
      });
    }
    return;
  }
  const checkRequest = request && typeof request === "object" ? request : undefined;
  const state = check(
    checkRequest && checkRequest.id,
    checkRequest && checkRequest.journalSizeLimit,
    checkRequest && checkRequest.force,
    checkRequest && checkRequest.generation,
  );
  if (isBarrier) {
    if (state.waitingForTruncate) pendingBarriers++;
    else parentPort.postMessage("barrier");
  }
  if (!state.waitingForTruncate && (pendingFrames(state) >= workerData.frames || state.blocked)) {
    idle = setTimeout(finish, workerData.idleMs);
  }
});
`;

/**
 * Request worker checks after writes and wait only at safe write boundaries.
 */
const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: NodeSqlite.DatabaseSync,
) {
  const warn = (reason: string) =>
    Effect.logWarning(
      "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
      { reason },
    );
  if (typeof writer.isTransaction !== "boolean" || typeof writer.setAuthorizer !== "function") {
    yield* warn("Node SQLite lacks transaction-state or statement-authorizer support");
    return undefined;
  }
  const version = String(writer.prepare("SELECT sqlite_version() AS version").get()?.version);
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 51)) {
    yield* warn(`SQLite ${version} has no NOOP checkpoint`);
    return undefined;
  }
  const writerFrames = writer.prepare("PRAGMA wal_checkpoint(NOOP)");
  const writerJournalSizeLimit = writer.prepare("PRAGMA journal_size_limit");
  const readFrameCounts = () => {
    const state = writerFrames.get();
    const log = readSafeSqliteInteger(state?.log);
    const checkpointed = readSafeSqliteInteger(state?.checkpointed);
    if (log === undefined || checkpointed === undefined) {
      throw new Error("SQLite returned invalid WAL checkpoint frame counts");
    }
    return { log, checkpointed };
  };
  let worker: NodeWorkerThreads.Worker;
  try {
    worker = new NodeWorkerThreads.Worker(checkpointWorkerSource, {
      eval: true,
      workerData: {
        filename,
        frames: CHECKPOINT_FRAMES,
        backpressureFrames: CHECKPOINT_BACKPRESSURE_FRAMES,
        idleMs: CHECKPOINT_IDLE_MS,
      },
    });
  } catch (cause) {
    yield* warn(String(cause));
    return undefined;
  }
  // SQLite's automatic checkpoint runs inside the writer before the worker can react.
  writer.exec("PRAGMA wal_autocheckpoint = 0;");
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  let checking = false;
  let checkAgain = false;
  let nextCheckId = 0;
  let pendingCheckId: number | undefined;
  let forceCheckAgain = false;
  let logFrames = 0;
  let checkpointedFrames = 0;
  let checkpointBlocked = false;
  let frameStatusUnknown = false;
  let writerGeneration = 1;
  let journalSizeLimit = -1;
  let truncateRequestId: number | undefined;
  let truncatePaused = false;
  try {
    const state = readFrameCounts();
    logFrames = state.log;
    checkpointedFrames = state.checkpointed;
  } catch {
    frameStatusUnknown = true;
  }
  type AdmissionWaiter = {
    readonly write: boolean;
    resume: () => void;
    state: "queued" | "elected" | "settled" | "cancelled";
  };
  const waiters: Array<AdmissionWaiter> = [];
  let electedWaiter: AdmissionWaiter | undefined;
  let runWithAdmission: <A>(
    write: boolean,
    execute: () => SqliteExecutionResult<A>,
    admitted?: AdmissionWaiter,
  ) => Effect.Effect<A, SqlError>;
  const backlogFrames = () => logFrames - checkpointedFrames;
  const resumeWaiter = (waiter: (typeof waiters)[number]) => waiter.resume();
  const resumeWaiters = () => {
    const elected = electedWaiter;
    electedWaiter = undefined;
    if (elected !== undefined && elected.state !== "cancelled") {
      elected.state = "settled";
      resumeWaiter(elected);
    }
    for (const waiter of waiters.splice(0)) {
      if (waiter.state === "cancelled") continue;
      waiter.state = "settled";
      resumeWaiter(waiter);
    }
    worker.unref();
  };
  const resumeWaitersBelowThreshold = () => {
    if (
      waiters.length > 0 &&
      electedWaiter === undefined &&
      !frameStatusUnknown &&
      !checkpointBlocked &&
      truncateRequestId === undefined &&
      logFrames < CHECKPOINT_BACKPRESSURE_FRAMES
    ) {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.state = "elected";
        electedWaiter = waiter;
        resumeWaiter(waiter);
      }
      if (waiters.length === 0) worker.unref();
    }
  };
  const cancelWaiter = (waiter: AdmissionWaiter) => {
    const wasElected = waiter.state === "elected" && electedWaiter === waiter;
    if (waiter.state === "queued") {
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
    } else if (wasElected) {
      electedWaiter = undefined;
    }
    if (waiter.state !== "settled") waiter.state = "cancelled";
    if (wasElected) {
      // A cancelled elected wake transfers its one admission to the next waiter.
      resumeWaitersBelowThreshold();
    }
    if (waiters.length === 0) worker.unref();
  };
  const settleAdmission = (waiter: AdmissionWaiter) => {
    if (electedWaiter === waiter) electedWaiter = undefined;
    waiter.state = "settled";
  };
  const needsBackpressure = (write: boolean) =>
    write &&
    !stopped &&
    !writer.isTransaction &&
    (frameStatusUnknown ||
      checkpointBlocked ||
      truncateRequestId !== undefined ||
      logFrames >= CHECKPOINT_BACKPRESSURE_FRAMES);
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    truncateRequestId = undefined;
    truncatePaused = false;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint = ${CHECKPOINT_FRAMES};`);
    } catch {}
    resumeWaiters();
    runFork(warn(reason));
  };
  const acknowledgeTruncate = () => {
    if (truncateRequestId === undefined || truncatePaused || stopped || writer.isTransaction)
      return;
    truncatePaused = true;
    try {
      // The main thread is between statements and now admits no new writes.
      // Keep its event loop free while the worker takes SQLite's exclusive lock.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage({ type: "truncate", truncateId: truncateRequestId });
    } catch (cause) {
      truncatePaused = false;
      handBack(String(cause));
    }
  };
  worker.on("error", (cause) => handBack(cause.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      stopped = true;
      truncateRequestId = undefined;
      truncatePaused = false;
      resumeWaiters();
      return worker.terminate();
    }),
  );

  // At most one request is in flight. A statement that runs during it asks for
  // one more check, so the frames of a last commit before idle still get one.
  const check = (force = false) => {
    if (stopped || writer.isTransaction) return;
    if (truncateRequestId !== undefined) {
      acknowledgeTruncate();
      return;
    }
    const generation = ++writerGeneration;
    try {
      const state = readFrameCounts();
      logFrames = state.log;
      checkpointedFrames = state.checkpointed;
      frameStatusUnknown = false;
    } catch {
      frameStatusUnknown = true;
      force = true;
    }
    resumeWaitersBelowThreshold();
    const forceCheckpoint =
      force ||
      frameStatusUnknown ||
      checkpointBlocked ||
      logFrames >= CHECKPOINT_BACKPRESSURE_FRAMES;
    if (!forceCheckpoint && backlogFrames() < CHECKPOINT_FRAMES) return;
    if (checking) {
      checkAgain = true;
      forceCheckAgain ||= forceCheckpoint;
      return;
    }
    checking = true;
    const id = ++nextCheckId;
    pendingCheckId = id;
    try {
      const setting = readSafeSqliteInteger(writerJournalSizeLimit.get()?.journal_size_limit);
      if (setting !== undefined) journalSizeLimit = setting;
      const request = {
        type: "check",
        id,
        generation,
        journalSizeLimit,
        force: forceCheckpoint,
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      worker.postMessage(request);
    } catch (cause) {
      handBack(String(cause));
    }
  };
  worker.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "truncate-request" &&
      "truncateId" in message &&
      typeof message.truncateId === "number"
    ) {
      truncateRequestId = message.truncateId;
      checkpointBlocked = true;
      acknowledgeTruncate();
      return;
    }
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "checkpoint" &&
      "id" in message &&
      "log" in message &&
      typeof message.log === "number" &&
      "checkpointed" in message &&
      typeof message.checkpointed === "number" &&
      "blocked" in message &&
      typeof message.blocked === "boolean"
    ) {
      // This snapshot follows the acknowledged writer pause, so it can supersede
      // observations made before the worker took the exclusive checkpoint lock.
      const completedTruncate =
        "truncateId" in message &&
        typeof message.truncateId === "number" &&
        message.truncateId === truncateRequestId;
      const currentSnapshot =
        "generation" in message &&
        typeof message.generation === "number" &&
        (message.generation === writerGeneration || completedTruncate);
      if (currentSnapshot) {
        logFrames = message.log;
        checkpointedFrames = message.checkpointed;
        checkpointBlocked = message.blocked;
        frameStatusUnknown = false;
      }
      if (completedTruncate) {
        truncateRequestId = undefined;
        truncatePaused = false;
      }
    }
    if (message === "barrier") return;
    if (
      typeof message === "object" &&
      message !== null &&
      "id" in message &&
      message.id === pendingCheckId
    ) {
      checking = false;
      pendingCheckId = undefined;
    }
    if (checkAgain) {
      if (checking) return;
      const force = forceCheckAgain;
      checkAgain = false;
      forceCheckAgain = false;
      check(force);
      return;
    }
    if (!checking) resumeWaitersBelowThreshold();
  });
  // After the listeners: adding a "message" listener refs the worker again.
  worker.unref();
  const waitForAdmission = <A>(write: boolean, execute: () => SqliteExecutionResult<A>) =>
    Effect.suspend(() => {
      let scheduled = false;
      let resumed = false;
      const waiter: AdmissionWaiter = {
        write,
        state: "queued",
        resume: () => {},
      };
      const wait = Effect.uninterruptibleMask((restore) =>
        Effect.withFiber((fiber) =>
          (fiber.getRef(TransactionAcquire)?.restore ?? restore)(
            Effect.callback<void>(function (this: Scheduler.Scheduler, continueAdmission) {
              const dispatcher = this.makeDispatcher();
              waiter.resume = () => {
                if (waiter.state === "cancelled" || scheduled || resumed) return;
                scheduled = true;
                dispatcher.scheduleTask(() => {
                  scheduled = false;
                  if (waiter.state === "cancelled" || resumed) return;
                  resumed = true;
                  continueAdmission(Effect.void);
                }, 0);
              };
              waiters.push(waiter);
              worker.ref();
              check(true);
              return Effect.sync(() => cancelWaiter(waiter));
            }),
          ),
        ),
      );
      return wait.pipe(
        Effect.flatMap(() => runWithAdmission(write, execute, waiter)),
        // Keep cancellation ownership through the retry's final gate check.
        Effect.onInterrupt(() => Effect.sync(() => cancelWaiter(waiter))),
      );
    });
  runWithAdmission = <A>(
    write: boolean,
    execute: () => SqliteExecutionResult<A>,
    admitted?: AdmissionWaiter,
  ) =>
    Effect.suspend(() => {
      if (needsBackpressure(write)) {
        if (admitted !== undefined) settleAdmission(admitted);
        return waitForAdmission(write, execute);
      }
      if (admitted !== undefined) settleAdmission(admitted);
      const result = execute();
      return sqliteExecutionToEffect(result);
    });
  return { check, runWithAdmission };
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    // Started after the close finalizer, so the worker stops before the writer closes.
    const checkpoint =
      options.checkpointWorker && isFileDatabase
        ? yield* startCheckpointWorker(options.filename, db)
        : undefined;

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    interface CheckpointClassification {
      backpressure: boolean;
      check: boolean;
    }
    const checkpointClassifications = new WeakMap<
      NodeSqlite.StatementSync,
      CheckpointClassification
    >();
    const mutatingPragmasWithValues = new Set([
      "application_id",
      "auto_vacuum",
      "journal_mode",
      "schema_version",
      "user_version",
    ]);
    // Gate page mutations and checkpoints, while reads and connection settings stay available.
    const mutatesPragma = (name: string | null, value: string | null) => {
      const pragma = name?.toLowerCase();
      if (pragma === undefined) return false;
      if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
      if (pragma === "wal_checkpoint") return value?.toLowerCase() !== "noop";
      return value !== null && mutatingPragmasWithValues.has(pragma);
    };
    let activeClassification: CheckpointClassification | undefined;
    const withClassification = <A>(
      classification: CheckpointClassification | undefined,
      f: () => A,
    ): A => {
      if (classification === undefined) return f();
      const previous = activeClassification;
      activeClassification = classification;
      try {
        return f();
      } finally {
        activeClassification = previous;
      }
    };
    if (checkpoint !== undefined) {
      // SQLite may reprepare an expired statement while it executes. Keep this
      // callback installed and collect only around that statement's prepare/run.
      db.setAuthorizer((actionCode, action, argument) => {
        const classification = activeClassification;
        if (classification === undefined) return NodeSqlite.constants.SQLITE_OK;
        const constants = NodeSqlite.constants;
        if (actionCode === constants.SQLITE_TRANSACTION) {
          classification.backpressure ||= action === "BEGIN";
          classification.check ||= action === "COMMIT" || action === "ROLLBACK";
        } else if (actionCode === constants.SQLITE_SAVEPOINT) {
          classification.backpressure ||= action === "BEGIN";
          classification.check = true;
        } else if (actionCode === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
          classification.backpressure = true;
          classification.check = true;
        } else if (
          actionCode !== constants.SQLITE_READ &&
          actionCode !== constants.SQLITE_SELECT &&
          actionCode !== constants.SQLITE_FUNCTION &&
          actionCode !== constants.SQLITE_RECURSIVE &&
          actionCode !== constants.SQLITE_PRAGMA
        ) {
          classification.backpressure = true;
          classification.check = true;
        }
        return constants.SQLITE_OK;
      });
    }
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => {
          const classification = { backpressure: false, check: false };
          const statement = withClassification(classification, () => db.prepare(sql));
          if (checkpoint !== undefined) checkpointClassifications.set(statement, classification);
          return statement;
        },
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const classification = checkpointClassifications.get(statement);
        const execute = (): SqliteExecutionResult<ReadonlyArray<any>> => {
          try {
            const result = withClassification(classification, () => {
              statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
              if (hasRows(statement)) {
                return { rows: statement.all(...(params as any)), result: undefined };
              }
              return { rows: [], result: statement.run(...(params as any)) };
            });
            return {
              _tag: "Success",
              value:
                result.result === undefined || !raw
                  ? result.rows
                  : (result.result as unknown as ReadonlyArray<any>),
            };
          } catch (cause) {
            return {
              _tag: "Failure",
              error: new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
            };
          } finally {
            if (classification?.check) checkpoint?.check();
          }
        };
        if (checkpoint !== undefined && classification?.backpressure) {
          return checkpoint.runWithAdmission(true, execute);
        }
        return sqliteExecutionToEffect(execute());
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.withFiber<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>((fiber) => {
            const classification = checkpointClassifications.get(statement);
            const execute = (): SqliteExecutionResult<ReadonlyArray<ReadonlyArray<unknown>>> => {
              try {
                const rows = withClassification(classification, () => {
                  statement.setReadBigInts(
                    Boolean(Context.get(fiber.context, Client.SafeIntegers)),
                  );
                  if (hasRows(statement)) {
                    statement.setReturnArrays(true);
                    return statement.all(...(params as any)) as unknown as ReadonlyArray<
                      ReadonlyArray<unknown>
                    >;
                  }
                  statement.run(...(params as any));
                  return [];
                });
                return { _tag: "Success", value: rows };
              } catch (cause) {
                return {
                  _tag: "Failure",
                  error: new SqlError({
                    reason: classifyError(cause, "Failed to execute statement", "execute"),
                  }),
                };
              } finally {
                if (classification?.check) checkpoint?.check();
              }
            };
            if (checkpoint !== undefined && classification?.backpressure) {
              return checkpoint.runWithAdmission(true, execute);
            }
            return sqliteExecutionToEffect(execute());
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  const acquireReader =
    options.readerWorker && isFileDatabase ? yield* makeReader(options) : undefined;
  const readerSemaphore = yield* Semaphore.make(1);

  const writer = { name: "writer" as const, lock: semaphore, connection };
  const route = Effect.withFiber((fiber) =>
    acquireReader !== undefined && Context.get(fiber.context, ReadOnly)
      ? Effect.map(acquireReader, (readerConnection) =>
          readerConnection === undefined
            ? writer
            : { name: "reader" as const, lock: readerSemaphore, connection: readerConnection },
        )
      : Effect.succeed(writer),
  );

  const acquired = (
    target: { readonly name: Acquired["connection"] },
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection: target.name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const acquirer = Effect.flatMap(route, (target) =>
    Effect.withFiber((fiber) => {
      if (
        !fiber.getRef(References.TracerEnabled) ||
        !fiber.getRef(Statement.SpanPropagationEnabled)
      ) {
        return target.lock.withPermits(1)(Effect.succeed(target.connection));
      }
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      return target.lock.withPermits(1)(
        Effect.sync(() => {
          annotateAcquired(fiber, acquired(target, clock, start));
          return target.connection;
        }),
      );
    }),
  );
  const borrower: Borrower = (f) =>
    Effect.flatMap(route, (target) =>
      Effect.withFiber((fiber) => {
        const useConnection = Effect.suspend(() => f(target.connection));
        if (
          !fiber.getRef(References.TracerEnabled) ||
          !fiber.getRef(Statement.SpanPropagationEnabled)
        ) {
          return target.lock.withPermits(1)(useConnection);
        }
        const clock = fiber.getRef(Clock.Clock);
        const start = clock.monotonicTimeNanosUnsafe();
        return target.lock.withPermits(1)(
          Effect.andThen(
            Effect.sync(() => annotateAcquired(fiber, acquired(target, clock, start))),
            useConnection,
          ),
        );
      }),
    );
  const transactionAcquirer = Effect.flatMap(route, (target) =>
    Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const pending = fiber.getRef(TransactionAcquire);
      const acquire = Effect.tap((pending?.restore ?? restore)(target.lock.take(1)), () => {
        if (pending !== undefined) pending.acquired = acquired(target, clock, start);
        return Scope.addFinalizer(scope, target.lock.release(1));
      });
      return Effect.as(
        // Semaphore.take claims the permit before it returns; don't yield before its finalizer is registered.
        Effect.provideService(acquire, Scheduler.PreventSchedulerYield, true),
        target.connection,
      );
    }),
  );

  const client = yield* Client.make({
    acquirer,
    borrower,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) => {
        // SqlClient masks its setup; waits must inherit the caller's mask, including cleanup.
        const pending: { acquired?: Acquired; restore: typeof Effect.interruptible | undefined } = {
          restore,
        };
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired);
          pending.restore = undefined;
          return effect;
        });
        return restore(
          withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending)),
        );
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
