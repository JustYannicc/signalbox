import {
  CommandId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * What one thread's Durable Object persists: its event log, the receipt of
 * every command it decided, who owns it, and the summary outbox that feeds the
 * owner's sidebar. Each thread has its own SQLite database, so nothing here
 * names another thread.
 *
 * Events are stored in a versioned record format, because Worker versions
 * overlap during a rollout and an older one may read what a newer one wrote.
 */

/** Bump when the stored event encoding changes; readers refuse formats they do not know. */
const EVENT_FORMAT = 1;

export interface StoredEvent {
  readonly sequence: number;
  readonly event: OrchestrationV2DomainEvent;
}

export interface ThreadOwner {
  readonly userId: string;
  /** The context the thread acts as, fixed at creation (see `CloudThreadService`). */
  readonly contextId: SignalboxContextId;
}

export type CommandReceipt =
  | { readonly _tag: "accepted"; readonly sequence: number }
  | { readonly _tag: "rejected"; readonly message: string };

export interface OutboxState {
  /** The latest summary revision, the event sequence that last changed the thread's sidebar row. */
  readonly revision: number;
  /** The highest revision the owner's object has acknowledged. */
  readonly delivered: number;
}

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    /** Whether the thread's tables exist. They are created with the thread, never before. */
    readonly initialized: Effect.Effect<boolean, SqlError>;
    /** Creates or upgrades the tables. */
    readonly initialize: Effect.Effect<void, SqlError | Migrator.MigrationError>;
    readonly owner: Effect.Effect<ThreadOwner | null, SqlError>;
    readonly events: (afterSequence: number) => Effect.Effect<ReadonlyArray<StoredEvent>, SqlError>;
    readonly receipt: (commandId: CommandId) => Effect.Effect<CommandReceipt | null, SqlError>;
    /**
     * Appends events after `head`, the command's receipt, the owner (when the
     * thread is being created) and the outbox revision, in one transaction.
     * Returns the new head.
     */
    readonly commit: (input: {
      readonly head: number;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly command?: { readonly id: CommandId; readonly type: string };
      readonly owner?: ThreadOwner;
      readonly summaryChanged: boolean;
    }) => Effect.Effect<number, SqlError>;
    readonly recordRejection: (input: {
      readonly command: { readonly id: CommandId; readonly type: string };
      readonly message: string;
    }) => Effect.Effect<void, SqlError>;
    readonly outbox: Effect.Effect<OutboxState, SqlError>;
    readonly acknowledgeSummary: (revision: number) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/thread/ThreadStore") {}

const migrations = Migrator.fromRecord({
  "0001_thread": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_id TEXT NOT NULL,
      context_id TEXT NOT NULL DEFAULT 'personal'
    )`;
    yield* sql`CREATE TABLE events (
      sequence INTEGER PRIMARY KEY,
      command_id TEXT,
      format INTEGER NOT NULL,
      event TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE receipts (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      status TEXT NOT NULL,
      result_sequence INTEGER,
      message TEXT,
      decided_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      delivered INTEGER NOT NULL
    )`;
    yield* sql`INSERT INTO outbox (id, revision, delivered) VALUES (1, 0, 0)`;
  }),
});

/** Applies pending migrations. Ids only ever grow; never renumber one. */
const migrate = Migrator.make({})({ loader: migrations });

const EventJson = Schema.fromJsonString(OrchestrationV2DomainEventJson);
const encodeEvent = Schema.encodeSync(EventJson);
const decodeEvent = Schema.decodeUnknownSync(EventJson);

const EventRow = Schema.Struct({
  sequence: Schema.Number,
  format: Schema.Number,
  event: Schema.String,
});
const OwnerRow = Schema.Struct({ user_id: Schema.String, context_id: SignalboxContextId });
const ReceiptRow = Schema.Struct({
  status: Schema.Literals(["accepted", "rejected"]),
  result_sequence: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
});
const OutboxRow = Schema.Struct({ revision: Schema.Number, delivered: Schema.Number });
const decodeEventRows = Schema.decodeUnknownSync(Schema.Array(EventRow));
const decodeOwnerRows = Schema.decodeUnknownSync(Schema.Array(OwnerRow));
const decodeReceiptRows = Schema.decodeUnknownSync(Schema.Array(ReceiptRow));
const decodeOutboxRows = Schema.decodeUnknownSync(Schema.Array(OutboxRow));

const toStoredEvent = (row: typeof EventRow.Type): StoredEvent => {
  if (row.format !== EVENT_FORMAT) {
    throw new Error(
      `Event ${row.sequence} has record format ${row.format}, newer than this build.`,
    );
  }
  return { sequence: row.sequence, event: decodeEvent(row.event) };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const owner: ThreadStore["Service"]["owner"] = sql`SELECT user_id, context_id FROM owner`.pipe(
    Effect.map((rows) => {
      const [row] = decodeOwnerRows(rows);
      return row ? { userId: row.user_id, contextId: row.context_id } : null;
    }),
  );

  const events: ThreadStore["Service"]["events"] = (afterSequence) =>
    sql`SELECT sequence, format, event FROM events WHERE sequence > ${afterSequence}
      ORDER BY sequence`.pipe(Effect.map((rows) => decodeEventRows(rows).map(toStoredEvent)));

  const receipt: ThreadStore["Service"]["receipt"] = (commandId) =>
    sql`SELECT status, result_sequence, message FROM receipts WHERE command_id = ${commandId}`.pipe(
      Effect.map((rows): CommandReceipt | null => {
        const [row] = decodeReceiptRows(rows);
        if (!row) return null;
        return row.status === "accepted"
          ? { _tag: "accepted", sequence: row.result_sequence ?? 0 }
          : { _tag: "rejected", message: row.message ?? "Rejected." };
      }),
    );

  const commit: ThreadStore["Service"]["commit"] = Effect.fn("ThreadStore.commit")(function* (
    input,
  ) {
    const now = yield* Clock.currentTimeMillis;
    let sequence = input.head;
    for (const event of input.events) {
      sequence += 1;
      yield* sql`INSERT INTO events (sequence, command_id, format, event)
          VALUES (${sequence}, ${input.command?.id ?? null}, ${EVENT_FORMAT}, ${encodeEvent(event)})`;
    }
    if (input.command) {
      yield* sql`INSERT INTO receipts (command_id, command_type, status, result_sequence, decided_at)
          VALUES (${input.command.id}, ${input.command.type}, 'accepted', ${sequence}, ${now})`;
    }
    if (input.owner) {
      yield* sql`INSERT INTO owner (id, user_id, context_id)
          VALUES (1, ${input.owner.userId}, ${input.owner.contextId})`;
    }
    if (input.summaryChanged) {
      yield* sql`UPDATE outbox SET revision = ${sequence} WHERE id = 1`;
    }
    return sequence;
  }, sql.withTransaction);

  const recordRejection: ThreadStore["Service"]["recordRejection"] = Effect.fn(
    "ThreadStore.recordRejection",
  )(function* ({ command, message }) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO receipts (command_id, command_type, status, message, decided_at)
      VALUES (${command.id}, ${command.type}, 'rejected', ${message}, ${now})
      ON CONFLICT (command_id) DO NOTHING`;
  });

  const outbox: ThreadStore["Service"]["outbox"] =
    sql`SELECT revision, delivered FROM outbox WHERE id = 1`.pipe(
      Effect.map((rows) => decodeOutboxRows(rows)[0] ?? { revision: 0, delivered: 0 }),
    );

  const acknowledgeSummary: ThreadStore["Service"]["acknowledgeSummary"] = (revision) =>
    sql`UPDATE outbox SET delivered = MAX(delivered, ${revision}) WHERE id = 1`.pipe(Effect.asVoid);

  const initialized: ThreadStore["Service"]["initialized"] =
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  return ThreadStore.of({
    initialized,
    initialize: Effect.asVoid(migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
    owner,
    events,
    receipt,
    commit,
    recordRejection,
    outbox,
    acknowledgeSummary,
  });
});

export const layer = Layer.effect(ThreadStore, make);
