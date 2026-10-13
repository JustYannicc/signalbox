import {
  MachineUsage,
  RunnerBuild,
  RunnerLogLevel,
} from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId } from "@t3tools/contracts";
import { ellipsize } from "@t3tools/shared/String";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { ModelUsage } from "../../modelGateway/modelGatewayRecord.ts";
import { BACKEND_KINDS, WAKE_KINDS } from "../runner/MachineBackend.ts";

/**
 * Where a thread's object keeps what explains its turns: one record per
 * machine session (an awake period at one generation), one per turn, a log of
 * lifecycle receipts, Runner lines and ModelGateway requests, and the
 * analytics outbox. Tables come with the thread (`ThreadStore`'s migration
 * `0004_diagnostics`), so nothing here runs before the thread exists.
 *
 * The log keeps about the latest `MAX_LOG_LINES` lines per turn and per
 * machine generation, and records are kept for the latest `KEEP_RUNS` turns,
 * so a long thread does not grow without bound.
 */

const MAX_LOG_LINES = 500;
/** Trimming scans a turn's lines, so it runs every this many inserts, not every one. */
const TRIM_EVERY = 50;
const KEEP_RUNS = 200;
const MAX_MESSAGE_CHARS = 2_000;

export const migrateDiagnostics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE receipts ADD COLUMN trace_id TEXT`;
  yield* sql`CREATE TABLE diag_sessions (
    generation INTEGER PRIMARY KEY,
    ended INTEGER NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0,
    record TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE diag_runs (
    run_id TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    trace_id TEXT NOT NULL,
    record TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX diag_runs_trace ON diag_runs (trace_id)`;
  yield* sql`CREATE TABLE diag_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    at INTEGER NOT NULL,
    generation INTEGER,
    run_id TEXT,
    source TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX diag_log_run ON diag_log (run_id, id)`;
  yield* sql`CREATE INDEX diag_log_generation ON diag_log (generation, id)`;
  yield* sql`CREATE TABLE diag_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    finalized_through INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO diag_state (id, finalized_through) VALUES (1, 0)`;
  yield* sql`CREATE TABLE analytics_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL,
    event TEXT NOT NULL,
    distinct_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    properties TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`;
});

/** Why a machine session ended. `outgrown`: its run moved to a heavy machine (#134). */
export const StopReason = Schema.Literals(["idle", "ttl", "reaper", "error", "outgrown"]);
export type StopReason = typeof StopReason.Type;

/** One awake period of the thread's machine: everything from its request to its release. */
export const MachineSession = Schema.Struct({
  generation: Schema.Number,
  /** The turn that woke the machine. */
  runId: Schema.NullOr(Schema.String),
  backend: Schema.Literals(BACKEND_KINDS),
  /** The machine size, e.g. boat's `small`. */
  shape: Schema.NullOr(Schema.String),
  /** The Runner image the backend was told to run. */
  image: Schema.NullOr(Schema.String),
  machineId: Schema.NullOr(Schema.String),
  wake: Schema.NullOr(Schema.Literals(WAKE_KINDS)),
  requestedAt: Schema.Number,
  /** The first `hello` the thread let in. */
  readyAt: Schema.NullOr(Schema.Number),
  /** The first batch the Runner sent. */
  firstEventAt: Schema.NullOr(Schema.Number),
  /** What the Runner said about itself in its latest `hello`. */
  runner: Schema.NullOr(
    Schema.Struct({
      protocolVersion: Schema.Number,
      imageVersion: Schema.String,
      machineId: Schema.String,
      build: Schema.NullOr(RunnerBuild),
    }),
  ),
  connections: Schema.Number,
  usage: Schema.NullOr(MachineUsage),
  /** The turns that ran on it. */
  runs: Schema.Array(Schema.String),
  endedAt: Schema.NullOr(Schema.Number),
  idleTailMs: Schema.NullOr(Schema.Number),
  stopReason: Schema.NullOr(StopReason),
  stopDetail: Schema.NullOr(Schema.String),
});
export type MachineSession = typeof MachineSession.Type;

/** What a turn collected on its way, beyond what the thread's own events say. */
export const RunDiagnostics = Schema.Struct({
  runId: Schema.String,
  ordinal: Schema.Number,
  traceId: Schema.String,
  /** The machine generations the turn ran on, in order. */
  generations: Schema.Array(Schema.Number),
  /** Reconnects and replaced machines while the turn was live. */
  recoveries: Schema.Number,
  /** CPU the machine used while the turn was live, summed across its generations. */
  cpuSeconds: Schema.NullOr(Schema.Number),
  /** The latest usage sample and its generation, the baseline for the next one. */
  lastUsage: Schema.NullOr(MachineUsage),
  lastUsageGeneration: Schema.NullOr(Schema.Number),
  memoryPeakBytes: Schema.NullOr(Schema.Number),
  usageSamples: Schema.Number,
  modelRequests: Schema.Number,
  /** Tokens by the model the provider reported. */
  modelTokens: Schema.Record(Schema.String, ModelUsage),
});
export type RunDiagnostics = typeof RunDiagnostics.Type;

export const LogSource = Schema.Literals(["thread", "machine", "runner", "gateway"]);

export const LogLine = Schema.Struct({
  at: Schema.Number,
  generation: Schema.NullOr(Schema.Number),
  runId: Schema.NullOr(Schema.String),
  source: LogSource,
  level: RunnerLogLevel,
  message: Schema.String,
});
export type LogLine = typeof LogLine.Type;

export interface OutboxEvent {
  readonly id: number;
  readonly uuid: string;
  readonly event: string;
  readonly distinctId: string;
  readonly at: number;
  readonly properties: string;
  readonly attempts: number;
}

const SessionJson = Schema.fromJsonString(MachineSession);
const RunJson = Schema.fromJsonString(RunDiagnostics);
const encodeSession = Schema.encodeSync(SessionJson);
const encodeRun = Schema.encodeSync(RunJson);
const decodeSessionRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ record: SessionJson })),
);
const decodeRunRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ record: RunJson })));
const decodeTraceRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ run_id: Schema.String, trace_id: Schema.String })),
);
const decodeLogRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      at: Schema.Number,
      generation: Schema.NullOr(Schema.Number),
      run_id: Schema.NullOr(Schema.String),
      source: LogSource,
      level: RunnerLogLevel,
      message: Schema.String,
    }),
  ),
);
const decodeOutboxRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      uuid: Schema.String,
      event: Schema.String,
      distinct_id: Schema.String,
      at: Schema.Number,
      properties: Schema.String,
      attempts: Schema.Number,
    }),
  ),
);
const decodeNumberRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ n: Schema.Number })),
);
const decodeTextRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ t: Schema.NullOr(Schema.String) })),
);

export class DiagnosticsStore extends Context.Service<
  DiagnosticsStore,
  {
    readonly session: (generation: number) => Effect.Effect<MachineSession | null>;
    readonly saveSession: (session: MachineSession) => Effect.Effect<void>;
    /** Sessions that ended and were not reported yet. */
    readonly unreportedSessions: Effect.Effect<ReadonlyArray<MachineSession>>;
    readonly markReported: (generation: number) => Effect.Effect<void>;
    readonly sessionsIn: (
      generations: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<MachineSession>>;
    readonly run: (runId: string) => Effect.Effect<RunDiagnostics | null>;
    readonly saveRun: (run: RunDiagnostics) => Effect.Effect<void>;
    /** Each recorded turn's trace id, by run id. */
    readonly traceIds: Effect.Effect<ReadonlyMap<string, string>>;
    readonly runOfTrace: (traceId: string) => Effect.Effect<string | null>;
    /** The trace of the turn a command started, from its receipt. */
    readonly traceOfCommand: (commandId: string) => Effect.Effect<string | null>;
    /** Appends a line. A `key` already logged (a resent Runner batch) is ignored. */
    readonly log: (line: LogLine, key?: string) => Effect.Effect<void>;
    /** A turn's lines, and its machines' lines from while it ran. */
    readonly logFor: (input: {
      readonly runId: string;
      readonly generations: ReadonlyArray<number>;
      readonly from: number;
      readonly to: number;
    }) => Effect.Effect<ReadonlyArray<LogLine>>;
    readonly finalizedThrough: Effect.Effect<number>;
    readonly setFinalizedThrough: (ordinal: number) => Effect.Effect<void>;
    /**
     * Forgets turns before the latest `KEEP_RUNS`, their lines, and reported
     * machines none of the rest used.
     */
    readonly prune: (latestOrdinal: number) => Effect.Effect<void>;
    readonly enqueue: (event: Omit<OutboxEvent, "id" | "attempts">) => Effect.Effect<void>;
    readonly outbox: (limit: number) => Effect.Effect<ReadonlyArray<OutboxEvent>>;
    readonly hasOutbox: Effect.Effect<boolean>;
    readonly removeOutbox: (ids: ReadonlyArray<number>) => Effect.Effect<void>;
    /** Counts a failed send; drops events that failed `maxAttempts` times. */
    readonly failedOutbox: (ids: ReadonlyArray<number>, maxAttempts: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/diagnostics/DiagnosticsStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Storage failures inside an object are fatal for the request, as in `ThreadStore`.
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const sessionsWhere = (rows: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    run(rows).pipe(Effect.map((found) => decodeSessionRows(found).map((row) => row.record)));

  const session: DiagnosticsStore["Service"]["session"] = (generation) =>
    Effect.map(
      sessionsWhere(sql`SELECT record FROM diag_sessions WHERE generation = ${generation}`),
      (sessions) => sessions[0] ?? null,
    );

  const saveSession: DiagnosticsStore["Service"]["saveSession"] = (value) =>
    run(sql`INSERT INTO diag_sessions (generation, ended, record)
      VALUES (${value.generation}, ${value.endedAt === null ? 0 : 1}, ${encodeSession(value)})
      ON CONFLICT (generation) DO UPDATE SET ended = excluded.ended, record = excluded.record`).pipe(
      Effect.asVoid,
    );

  const getRun: DiagnosticsStore["Service"]["run"] = (runId) =>
    run(sql`SELECT record FROM diag_runs WHERE run_id = ${runId}`).pipe(
      Effect.map((rows) => decodeRunRows(rows)[0]?.record ?? null),
    );

  const saveRun: DiagnosticsStore["Service"]["saveRun"] = (value) =>
    run(sql`INSERT INTO diag_runs (run_id, ordinal, trace_id, record)
      VALUES (${value.runId}, ${value.ordinal}, ${value.traceId}, ${encodeRun(value)})
      ON CONFLICT (run_id) DO UPDATE SET record = excluded.record`).pipe(Effect.asVoid);

  const firstText = (rows: ReadonlyArray<unknown>) => decodeTextRows(rows)[0]?.t ?? null;

  /** Keeps the newest lines of one turn, or of one generation's lines outside any turn. */
  const trim = (line: LogLine) =>
    line.runId === null
      ? sql`DELETE FROM diag_log WHERE run_id IS NULL AND generation IS ${line.generation}
          AND id NOT IN (SELECT id FROM diag_log WHERE run_id IS NULL
            AND generation IS ${line.generation} ORDER BY id DESC LIMIT ${MAX_LOG_LINES})`
      : sql`DELETE FROM diag_log WHERE run_id = ${line.runId} AND id NOT IN (
          SELECT id FROM diag_log WHERE run_id = ${line.runId}
          ORDER BY id DESC LIMIT ${MAX_LOG_LINES})`;

  const log: DiagnosticsStore["Service"]["log"] = (line, key) =>
    run(
      Effect.gen(function* () {
        const inserted = decodeNumberRows(
          yield* sql`INSERT INTO diag_log (key, at, generation, run_id, source, level, message)
            VALUES (${key ?? null}, ${line.at}, ${line.generation}, ${line.runId}, ${line.source},
              ${line.level}, ${ellipsize(line.message, MAX_MESSAGE_CHARS)})
            ON CONFLICT (key) DO NOTHING RETURNING id AS n`,
        );
        const id = inserted[0]?.n;
        if (id !== undefined && id % TRIM_EVERY === 0) yield* trim(line);
      }),
    );

  const logFor: DiagnosticsStore["Service"]["logFor"] = ({ runId, generations, from, to }) =>
    run(
      sql`SELECT at, generation, run_id, source, level, message FROM diag_log
        WHERE run_id = ${runId}
          OR (run_id IS NULL AND ${sql.in("generation", generations)}
            AND at >= ${from} AND at <= ${to})
        ORDER BY id`,
    ).pipe(
      Effect.map((rows) =>
        decodeLogRows(rows).map(({ run_id, ...line }) => ({ ...line, runId: run_id })),
      ),
    );

  const prune: DiagnosticsStore["Service"]["prune"] = (latestOrdinal) =>
    run(
      Effect.gen(function* () {
        const before = latestOrdinal - KEEP_RUNS;
        if (before <= 0) return;
        yield* sql`DELETE FROM diag_log WHERE run_id IN (
          SELECT run_id FROM diag_runs WHERE ordinal <= ${before})`;
        yield* sql`DELETE FROM diag_runs WHERE ordinal <= ${before}`;
        // Generations only grow, so the oldest kept turn holds the oldest kept machine.
        const [oldestRun] = decodeRunRows(
          yield* sql`SELECT record FROM diag_runs ORDER BY ordinal LIMIT 1`,
        );
        const oldest = oldestRun?.record.generations[0];
        if (oldest === undefined) return;
        yield* sql`DELETE FROM diag_log WHERE run_id IS NULL AND generation < ${oldest}`;
        yield* sql`DELETE FROM diag_sessions WHERE generation < ${oldest} AND reported = 1`;
      }),
    );

  const failedOutbox: DiagnosticsStore["Service"]["failedOutbox"] = (ids, maxAttempts) =>
    ids.length === 0
      ? Effect.void
      : run(
          Effect.gen(function* () {
            yield* sql`UPDATE analytics_outbox SET attempts = attempts + 1
              WHERE ${sql.in("id", ids)}`;
            yield* sql`DELETE FROM analytics_outbox WHERE attempts >= ${maxAttempts}`;
          }),
        );

  return DiagnosticsStore.of({
    session,
    saveSession,
    unreportedSessions: sessionsWhere(
      sql`SELECT record FROM diag_sessions WHERE ended = 1 AND reported = 0 ORDER BY generation`,
    ),
    markReported: (generation) =>
      run(sql`UPDATE diag_sessions SET reported = 1 WHERE generation = ${generation}`).pipe(
        Effect.asVoid,
      ),
    sessionsIn: (generations) =>
      generations.length === 0
        ? Effect.succeed([])
        : sessionsWhere(
            sql`SELECT record FROM diag_sessions WHERE ${sql.in("generation", generations)}
              ORDER BY generation`,
          ),
    run: getRun,
    saveRun,
    traceIds: run(sql`SELECT run_id, trace_id FROM diag_runs`).pipe(
      Effect.map(
        (rows) => new Map(decodeTraceRows(rows).map((row) => [row.run_id, row.trace_id] as const)),
      ),
    ),
    runOfTrace: (traceId) =>
      run(sql`SELECT run_id AS t FROM diag_runs WHERE trace_id = ${traceId} LIMIT 1`).pipe(
        Effect.map(firstText),
      ),
    traceOfCommand: (commandId) =>
      run(sql`SELECT trace_id AS t FROM receipts WHERE command_id = ${commandId}`).pipe(
        Effect.map(firstText),
      ),
    log,
    logFor,
    finalizedThrough: run(sql`SELECT finalized_through AS n FROM diag_state WHERE id = 1`).pipe(
      Effect.map((rows) => decodeNumberRows(rows)[0]?.n ?? 0),
    ),
    setFinalizedThrough: (ordinal) =>
      run(sql`UPDATE diag_state SET finalized_through = ${ordinal} WHERE id = 1`).pipe(
        Effect.asVoid,
      ),
    prune,
    enqueue: (event) =>
      run(sql`INSERT INTO analytics_outbox (uuid, event, distinct_id, at, properties)
        VALUES (${event.uuid}, ${event.event}, ${event.distinctId}, ${event.at},
          ${event.properties})`).pipe(Effect.asVoid),
    outbox: (limit) =>
      run(
        sql`SELECT id, uuid, event, distinct_id, at, properties, attempts FROM analytics_outbox
          ORDER BY id LIMIT ${limit}`,
      ).pipe(
        Effect.map((rows) =>
          decodeOutboxRows(rows).map(({ distinct_id, ...event }) => ({
            ...event,
            distinctId: distinct_id,
          })),
        ),
      ),
    hasOutbox: run(sql`SELECT 1 AS n FROM analytics_outbox LIMIT 1`).pipe(
      Effect.map((rows) => rows.length > 0),
    ),
    removeOutbox: (ids) =>
      ids.length === 0
        ? Effect.void
        : run(sql`DELETE FROM analytics_outbox WHERE ${sql.in("id", ids)}`).pipe(Effect.asVoid),
    failedOutbox,
  });
});

export const layer = Layer.effect(DiagnosticsStore, make);

/** A turn's record id, for typing callers that only know the run. */
export type DiagnosedRun = { readonly id: RunId; readonly ordinal: number };
