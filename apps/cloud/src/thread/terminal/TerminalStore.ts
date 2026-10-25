import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** Kept per terminal, including across Durable Object eviction. */
export interface TerminalRecord {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly generation: number;
  readonly leaseGeneration: number;
  /** Runner process identity, distinct from its reconnecting socket. */
  readonly processId: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
  readonly openRequestId: string;
  readonly closeRequestId: string | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closing" | "closed";
  readonly pid: number | null;
  readonly label: string;
  readonly hasRunningSubprocess: boolean;
  readonly deleteHistory: boolean;
  readonly processLost: boolean;
  readonly history: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly updatedAt: string;
  /** Last runner event accepted for this process generation. */
  readonly sequence: number;
  readonly revision: number;
}

/** A result receipt stays until the terminal is closed, so an old retry cannot type twice. */
export interface TerminalCommandRecord {
  readonly requestId: string;
  readonly terminalId: string;
  readonly generation: number;
  readonly leaseGeneration: number;
  readonly kind: "open" | "write" | "close" | "resize" | "clear";
  readonly commandId: string | null;
  readonly digest: string | null;
  readonly data: string | null;
  readonly outcome: "pending" | "done" | "error" | "abandoned";
}

export class TerminalStore extends Context.Service<
  TerminalStore,
  {
    readonly processId: (leaseGeneration: number) => Effect.Effect<string | null, SqlError>;
    readonly saveProcess: (
      leaseGeneration: number,
      processId: string,
    ) => Effect.Effect<void, SqlError>;
    readonly get: (terminalId: string) => Effect.Effect<TerminalRecord | null, SqlError>;
    readonly all: Effect.Effect<ReadonlyArray<TerminalRecord>, SqlError>;
    readonly save: (record: TerminalRecord) => Effect.Effect<void, SqlError>;
    readonly remove: (terminalId: string) => Effect.Effect<void, SqlError>;
    readonly command: (requestId: string) => Effect.Effect<TerminalCommandRecord | null, SqlError>;
    readonly byCommandId: (
      terminalId: string,
      commandId: string,
    ) => Effect.Effect<TerminalCommandRecord | null, SqlError>;
    readonly pruneCommands: (
      terminalId: string,
      generation: number,
    ) => Effect.Effect<void, SqlError>;
    readonly rebindPending: (
      terminalId: string,
      generation: number,
      leaseGeneration: number,
    ) => Effect.Effect<void, SqlError>;
    readonly countCommands: (terminalId: string) => Effect.Effect<number, SqlError>;
    readonly addCommand: (command: TerminalCommandRecord) => Effect.Effect<void, SqlError>;
    readonly pending: (
      leaseGeneration: number,
    ) => Effect.Effect<ReadonlyArray<TerminalCommandRecord>, SqlError>;
    readonly complete: (
      requestId: string,
      outcome: "done" | "error",
    ) => Effect.Effect<void, SqlError>;
    readonly abandon: (terminalId: string, generation: number) => Effect.Effect<void, SqlError>;
    readonly atomic: <R, E, A>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
  }
>()("@signalbox/cloud/thread/terminal/TerminalStore") {}

const recordJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    terminalId: Schema.String,
    cwd: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
    generation: Schema.Number,
    leaseGeneration: Schema.Number,
    processId: Schema.NullOr(Schema.String),
    cols: Schema.Number,
    rows: Schema.Number,
    env: Schema.Record(Schema.String, Schema.String),
    openRequestId: Schema.String,
    closeRequestId: Schema.NullOr(Schema.String),
    status: Schema.Literals(["starting", "running", "exited", "error", "closing", "closed"]),
    pid: Schema.NullOr(Schema.Number),
    label: Schema.String,
    hasRunningSubprocess: Schema.Boolean,
    deleteHistory: Schema.Boolean,
    processLost: Schema.Boolean,
    history: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    exitSignal: Schema.NullOr(Schema.Number),
    updatedAt: Schema.String,
    sequence: Schema.Number,
    revision: Schema.Number,
  }),
);
const decodeRecords = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ state: recordJson })));
const encodeRecord = Schema.encodeSync(recordJson);
const decodeCommands = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      requestId: Schema.String,
      terminalId: Schema.String,
      generation: Schema.Number,
      leaseGeneration: Schema.Number,
      kind: Schema.Literals(["open", "write", "close", "resize", "clear"]),
      commandId: Schema.NullOr(Schema.String),
      digest: Schema.NullOr(Schema.String),
      data: Schema.NullOr(Schema.String),
      outcome: Schema.Literals(["pending", "done", "error", "abandoned"]),
    }),
  ),
);
const decodeCount = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ count: Schema.Number })));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let ready = false;
  const tables = Effect.suspend(() =>
    ready
      ? Effect.void
      : Effect.gen(function* () {
          // Fork tables create themselves; no numbered ThreadStore migration can collide upstream.
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_terminal_runner (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            generation INTEGER NOT NULL,
            process_id TEXT NOT NULL
          )`;
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_terminals (
            terminal_id TEXT PRIMARY KEY,
            state TEXT NOT NULL
          )`;
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_terminal_commands (
            requestId TEXT PRIMARY KEY,
            terminalId TEXT NOT NULL,
            generation INTEGER NOT NULL,
            leaseGeneration INTEGER NOT NULL,
            kind TEXT NOT NULL,
            commandId TEXT,
            digest TEXT,
            data TEXT,
            outcome TEXT NOT NULL
          )`;
          yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS cloud_terminal_command_ids
            ON cloud_terminal_commands (terminalId, commandId) WHERE commandId IS NOT NULL`;
          yield* sql`CREATE INDEX IF NOT EXISTS cloud_terminal_pending
            ON cloud_terminal_commands (leaseGeneration, outcome)`;
          ready = true;
        }),
  );

  const get: TerminalStore["Service"]["get"] = (terminalId) =>
    Effect.andThen(
      tables,
      sql`SELECT state FROM cloud_terminals WHERE terminal_id = ${terminalId}`.pipe(
        Effect.map((rows) => decodeRecords(rows)[0]?.state ?? null),
      ),
    );
  const all: TerminalStore["Service"]["all"] = Effect.andThen(
    tables,
    sql`SELECT state FROM cloud_terminals ORDER BY terminal_id`.pipe(
      Effect.map((rows) => decodeRecords(rows).map(({ state }) => state)),
    ),
  );
  const save: TerminalStore["Service"]["save"] = (record) =>
    Effect.andThen(
      tables,
      sql`INSERT INTO cloud_terminals (terminal_id, state)
        VALUES (${record.terminalId}, ${encodeRecord(record)})
        ON CONFLICT (terminal_id) DO UPDATE SET state = excluded.state`.pipe(Effect.asVoid),
    );
  const remove: TerminalStore["Service"]["remove"] = (terminalId) =>
    Effect.andThen(
      tables,
      sql`DELETE FROM cloud_terminals WHERE terminal_id = ${terminalId}`.pipe(Effect.asVoid),
    );
  const command: TerminalStore["Service"]["command"] = (requestId) =>
    Effect.andThen(
      tables,
      sql`SELECT * FROM cloud_terminal_commands WHERE requestId = ${requestId}`.pipe(
        Effect.map((rows) => decodeCommands(rows)[0] ?? null),
      ),
    );
  const byCommandId: TerminalStore["Service"]["byCommandId"] = (terminalId, commandId) =>
    Effect.andThen(
      tables,
      sql`SELECT * FROM cloud_terminal_commands
        WHERE terminalId = ${terminalId} AND commandId = ${commandId}`.pipe(
        Effect.map((rows) => decodeCommands(rows)[0] ?? null),
      ),
    );
  const pruneCommands: TerminalStore["Service"]["pruneCommands"] = (terminalId, generation) =>
    Effect.andThen(
      tables,
      sql`DELETE FROM cloud_terminal_commands
        WHERE terminalId = ${terminalId} AND generation <> ${generation}`.pipe(Effect.asVoid),
    );
  const rebindPending: TerminalStore["Service"]["rebindPending"] = (
    terminalId,
    generation,
    leaseGeneration,
  ) =>
    Effect.andThen(
      tables,
      sql`UPDATE cloud_terminal_commands SET leaseGeneration = ${leaseGeneration}
        WHERE terminalId = ${terminalId} AND generation = ${generation}
          AND leaseGeneration = 0 AND outcome = 'pending'`.pipe(Effect.asVoid),
    );
  const countCommands: TerminalStore["Service"]["countCommands"] = (terminalId) =>
    Effect.andThen(
      tables,
      sql`SELECT count(*) AS count FROM cloud_terminal_commands WHERE terminalId = ${terminalId}`.pipe(
        Effect.map((rows) => decodeCount(rows)[0]?.count ?? 0),
      ),
    );
  const addCommand: TerminalStore["Service"]["addCommand"] = (input) =>
    Effect.andThen(
      tables,
      sql`INSERT INTO cloud_terminal_commands
        (requestId, terminalId, generation, leaseGeneration, kind, commandId, digest, data, outcome)
        VALUES (${input.requestId}, ${input.terminalId}, ${input.generation},
          ${input.leaseGeneration}, ${input.kind}, ${input.commandId}, ${input.digest},
          ${input.data}, ${input.outcome})`.pipe(Effect.asVoid),
    );
  const pending: TerminalStore["Service"]["pending"] = (leaseGeneration) =>
    Effect.andThen(
      tables,
      sql`SELECT * FROM cloud_terminal_commands
        WHERE leaseGeneration = ${leaseGeneration} AND outcome = 'pending'
        ORDER BY rowid LIMIT 256`.pipe(Effect.map(decodeCommands)),
    );
  const complete: TerminalStore["Service"]["complete"] = (requestId, outcome) =>
    Effect.andThen(
      tables,
      sql`UPDATE cloud_terminal_commands SET outcome = ${outcome}, data = NULL
        WHERE requestId = ${requestId} AND outcome = 'pending'`.pipe(Effect.asVoid),
    );
  const abandon: TerminalStore["Service"]["abandon"] = (terminalId, generation) =>
    Effect.andThen(
      tables,
      sql`UPDATE cloud_terminal_commands SET outcome = 'abandoned', data = NULL
        WHERE terminalId = ${terminalId} AND generation = ${generation} AND outcome = 'pending'`.pipe(
        Effect.asVoid,
      ),
    );

  yield* tables;

  return TerminalStore.of({
    processId: (leaseGeneration) =>
      Effect.andThen(
        tables,
        sql<{
          readonly process_id: string;
        }>`SELECT process_id FROM cloud_terminal_runner WHERE id = 1 AND generation = ${leaseGeneration}`.pipe(
          Effect.map((rows) => rows[0]?.process_id ?? null),
        ),
      ),
    saveProcess: (leaseGeneration, processId) =>
      Effect.andThen(
        tables,
        sql`INSERT INTO cloud_terminal_runner (id, generation, process_id) VALUES (1, ${leaseGeneration}, ${processId})
        ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, process_id = excluded.process_id`.pipe(
          Effect.asVoid,
        ),
      ),
    get,
    all,
    save,
    remove,
    command,
    byCommandId,
    pruneCommands,
    rebindPending,
    countCommands,
    addCommand,
    pending,
    complete,
    abandon,
    atomic: (effect) => sql.withTransaction(effect),
  });
});

export const layer = Layer.effect(TerminalStore, make);
