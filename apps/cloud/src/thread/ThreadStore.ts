import { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";
import { MachineClass } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  advanceCommandOutputSequence,
  readCommandOutputSequence,
  migrateCommandOutput,
  readCommandOutput,
  writeCommandOutput,
} from "./commandOutput/outputTables.ts";
import type {
  CommandOutputDelta,
  CommandOutputKey,
  RetainedCommandOutput,
} from "./commandOutput/retainedOutput.ts";
import * as Migrations from "../storage/migrations.ts";
import {
  migrateCurrentItemExpansion,
  migrateCurrentItemHistory,
  backfillCurrentItemState,
  recordCurrentItemState,
} from "./currentItemHistory.ts";
import { migrateDiagnostics } from "./diagnostics/DiagnosticsStore.ts";
import { migrateBrowsing } from "./browsing/browsingTables.ts";
import { migratePullRequestPolls } from "./pullRequests/PullRequestPolls.ts";
import { migrateStatusNote, readNote, writeNote } from "./statusLine/statusNoteTables.ts";
import { migratePulls } from "./PullState.ts";
import {
  type MachineRecord,
  MachineRecords,
  MachineStartupProblem,
  NO_MACHINE_RECORD,
} from "./runner/MachineBackend.ts";
import {
  migrateSecretValues,
  readSecretValues,
  registerSecretValues,
  type SecretValues,
} from "./runner/secretValues.ts";
import { type ThreadMonitor, ThreadMonitorWire } from "./threadWire.ts";

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
  /**
   * The drive the thread works in, fixed at creation. Null for threads created
   * before shared drives, which work in their owner's My Drive.
   */
  readonly driveId: string | null;
}

export type CommandReceipt =
  | { readonly _tag: "accepted"; readonly sequence: number }
  | { readonly _tag: "rejected"; readonly message: string };

/**
 * The thread's machine lease. Each machine the thread asks for gets the next
 * generation and a fresh token; only a Runner presenting both is let in, so a
 * machine from an earlier generation can never write to the thread again.
 * `ackedSequence` is the last Runner batch committed in this generation.
 */
export interface MachineLease {
  readonly generation: number;
  readonly token: string | null;
  /** `none`: no machine. `requested`: asked for, no Runner yet. `connected`: a Runner said hello. */
  readonly status: "none" | "requested" | "connected";
  /** Counts the Runner's connections in this generation; the latest one is current. */
  readonly connection?: number | undefined;
  readonly requestedAt: number | null;
  /** When the backend confirmed the request; null until then. */
  readonly ensuredAt: number | null;
  /** A bounded retry of the same idempotent request, before any Runner connected. */
  readonly startup?:
    | {
        readonly retries: number;
        readonly deadline: number;
        readonly problem?: MachineStartupProblem | undefined;
      }
    | undefined;
  /** When the Runner's socket closed, while the lease still stands. */
  readonly disconnectedAt: number | null;
  /** When the machine last ran out of work. */
  readonly idleSince: number | null;
  readonly ackedSequence: number;
  /** The class of machine this generation asked for (`runner/machineClass.ts`). Absent: heavy. */
  readonly machineClass?: MachineClass | undefined;
  /** The thread outgrew the light class, so every machine from now on is heavy. Kept across leases. */
  readonly movedUp?: boolean | undefined;
  /** This generation's Runner answers `drain` (#493), as its `hello` said. */
  readonly drains?: boolean | undefined;
  /** This generation's Runner takes `steer` (#562), as its `hello` said. */
  readonly steers?: boolean | undefined;
  /** This generation's Runner can receive committed native answers. */
  readonly runtimeResponses?: boolean | undefined;
  /** Already replaced an older Runner for this capability; don't loop on a stale image. */
  readonly runtimeResponsesUpgrade?: boolean | undefined;
  readonly pulls?: boolean | undefined;
  /**
   * The idle machine was asked to save everything before it goes (#493), at
   * `id` (when it was asked), and whether it answered and what it couldn't save.
   */
  readonly drain?: MachineDrain | undefined;
}

export type MachineDrain =
  | { readonly _tag: "asked"; readonly id: number }
  | { readonly _tag: "answered"; readonly id: number; readonly unsaved: ReadonlyArray<string> };

export const NO_MACHINE: MachineLease = {
  generation: 0,
  token: null,
  status: "none",
  requestedAt: null,
  ensuredAt: null,
  disconnectedAt: null,
  idleSince: null,
  ackedSequence: 0,
};

export interface OutboxState {
  /**
   * The latest summary revision: grows with every change to the thread's
   * sidebar row, to the event sequence that changed it, or by one for a
   * change outside the log (its attached runs).
   */
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
    /** Events after `afterSequence` in order, at most `limit` of them when given. */
    readonly events: (
      afterSequence: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<StoredEvent>, SqlError>;
    readonly commandOutputSequence: Effect.Effect<number, SqlError>;
    readonly commandOutput: (
      key: CommandOutputKey,
    ) => Effect.Effect<RetainedCommandOutput | null, SqlError>;
    readonly receipt: (commandId: CommandId) => Effect.Effect<CommandReceipt | null, SqlError>;
    /**
     * Appends events after `head`, the command's receipt, the owner (when the
     * thread is being created) and the outbox revision, in one transaction.
     * Returns the new head.
     */
    readonly commit: (input: {
      readonly head: number;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      /** `traceId`: the turn the command started, if it started one. */
      readonly command?: {
        readonly id: CommandId;
        readonly type: string;
        readonly traceId?: string | undefined;
      };
      readonly owner?: ThreadOwner;
      readonly summaryChanged: boolean;
      /** The machine lease as of these events, such as a Runner batch's acknowledgement. */
      readonly machine?: MachineLease;
      readonly commandOutputSeeds?: ReadonlyArray<CommandOutputKey>;
      readonly commandOutput?: ReadonlyArray<CommandOutputDelta>;
      /** The instructions of the thread's chain, for the run these events start. */
      readonly instructions?: {
        readonly runId: string;
        readonly levels: ReadonlyArray<FolderInstructions>;
      };
      /** The 1Password Environments of the thread's chain as of the run these events start. */
      readonly secrets?: ReadonlyArray<OnePasswordEnvironmentId>;
    }) => Effect.Effect<number, SqlError>;
    readonly recordRejection: (input: {
      readonly command: { readonly id: CommandId; readonly type: string };
      readonly message: string;
    }) => Effect.Effect<void, SqlError>;
    readonly outbox: Effect.Effect<OutboxState, SqlError>;
    readonly acknowledgeSummary: (revision: number) => Effect.Effect<void, SqlError>;
    /** The last event sequence the owner's automations acknowledged (`eventOutbox.ts`). */
    readonly eventsDelivered: Effect.Effect<number, SqlError>;
    readonly acknowledgeEvents: (through: number) => Effect.Effect<void, SqlError>;
    /** The automation runs attached to the thread. */
    readonly monitors: Effect.Effect<ReadonlyArray<ThreadMonitor>, SqlError>;
    /**
     * Replaces the attached runs; `summaryChanged` gives the sidebar row a new
     * revision with them, in one transaction.
     */
    readonly saveMonitors: (input: {
      readonly monitors: ReadonlyArray<ThreadMonitor>;
      readonly summaryChanged: boolean;
    }) => Effect.Effect<void, SqlError>;
    /** The thread's status note (#670, `statusLine/`); null until one was written. */
    readonly statusNote: Effect.Effect<ThreadStatusNote | null, SqlError>;
    /** Replaces the note; `summaryChanged` gives the sidebar row a new revision with it. */
    readonly saveStatusNote: (input: {
      readonly note: ThreadStatusNote;
      readonly summaryChanged: boolean;
    }) => Effect.Effect<void, SqlError>;
    readonly machine: Effect.Effect<MachineLease, SqlError>;
    readonly saveMachine: (machine: MachineLease) => Effect.Effect<void, SqlError>;
    /** The machine backend's record of the thread's machine (`MachineBackend.ts`). */
    readonly machineRecord: Effect.Effect<MachineRecord, SqlError>;
    readonly saveMachineRecord: (record: MachineRecord) => Effect.Effect<void, SqlError>;
    /** The instructions a run was started with, top level first; none for one started without. */
    readonly instructions: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<FolderInstructions>, SqlError>;
    /**
     * The 1Password Environments of the thread's chain, top level first, as
     * of its latest turn started from its owner's object: a continuation run
     * keeps its thread's. Empty when none.
     */
    readonly secrets: Effect.Effect<ReadonlyArray<OnePasswordEnvironmentId>, SqlError>;
    /** Their values, as the machine registered them (`runner/secretValues.ts`). Never log them. */
    readonly secretValues: Effect.Effect<SecretValues, SqlError>;
    /** Run it in the transaction that checks `generation` still holds the lease. */
    readonly registerSecretValues: (
      generation: number,
      secrets: ReadonlyArray<SecretValue>,
    ) => Effect.Effect<void, SqlError>;
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
  "0002_machine": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE machine (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lease TEXT NOT NULL
    )`;
  }),
  "0003_machine_record": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE machine_record (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      record TEXT NOT NULL
    )`;
  }),
  "0004_diagnostics": migrateDiagnostics,
  "0005_drive": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE owner ADD COLUMN drive_id TEXT`;
  }),
  // Each run's folder chain `AGENTS.md` as it was started with (#227), for the Runner.
  "0006_instructions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE run_instructions (
      run_id TEXT PRIMARY KEY,
      levels TEXT NOT NULL
    )`;
  }),
  // The thread's folder chain's 1Password Environments (#395), references only.
  // Per thread, not per run, so a continuation run on a new machine keeps them.
  "0007_secrets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE thread_secrets (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      environments TEXT NOT NULL
    )`;
  }),
  // When each linked pull request was last read from GitHub (`pullRequests/PullRequestSync.ts`).
  "0008_pull_request_polls": migratePullRequestPolls,
  // The owner's automations (#434): the last event their object acknowledged
  // (`eventOutbox.ts`), and the runs attached to the thread. A thread from
  // before starts at its head: automations hear what happens from now on.
  "0009_automations": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE event_outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      delivered INTEGER NOT NULL
    )`;
    yield* sql`INSERT INTO event_outbox (id, delivered)
      SELECT 1, COALESCE(MAX(sequence), 0) FROM events`;
    yield* sql`CREATE TABLE thread_monitors (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monitors TEXT NOT NULL
    )`;
  }),
  // The values of the thread's secrets, for the ModelGateway to scrub (#591).
  "0010_secret_values": migrateSecretValues,
  // The thread's browser tabs and their recent changes (#585, `browsing/browsingTables.ts`).
  // Same id as the one above on purpose: the runner keys by id and name (`storage/migrations.ts`).
  "0010_browsing": migrateBrowsing,
  // The thread's status note and the runtime's cursor through ended runs (#670, `statusLine/`).
  "0011_status_note": migrateStatusNote,
  "0012_command_output": migrateCommandOutput,
  "0012_git_pulls": migratePulls,
  "0012_current_item_history": migrateCurrentItemHistory,
  "0013_current_item_expansion": migrateCurrentItemExpansion,
});

/** Applies every migration not recorded yet (`storage/migrations.ts`). Never edit or rename a merged one. */
const migrate = Migrations.run(migrations);

const InstructionsJson = Schema.fromJsonString(Schema.Array(FolderInstructions));
const encodeInstructions = Schema.encodeSync(InstructionsJson);
const decodeInstructionRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ levels: InstructionsJson })),
);

const SecretsJson = Schema.fromJsonString(Schema.Array(OnePasswordEnvironmentId));
const encodeSecrets = Schema.encodeSync(SecretsJson);
const decodeSecretRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ environments: SecretsJson })),
);

const EventJson = Schema.fromJsonString(OrchestrationV2DomainEventJson);
const encodeEvent = Schema.encodeSync(EventJson);
const decodeEvent = Schema.decodeUnknownSync(EventJson);

const EventRow = Schema.Struct({
  sequence: Schema.Number,
  format: Schema.Number,
  event: Schema.String,
});
const OwnerRow = Schema.Struct({
  user_id: Schema.String,
  context_id: SignalboxContextId,
  drive_id: Schema.NullOr(Schema.String),
});
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
const decodeDeliveredRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ delivered: Schema.Number })),
);

const MonitorsJson = Schema.fromJsonString(Schema.Array(ThreadMonitorWire));
const encodeMonitors = Schema.encodeSync(MonitorsJson);
const decodeMonitorRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ monitors: MonitorsJson })),
);

const MachineLeaseJson = Schema.fromJsonString(
  Schema.Struct({
    generation: Schema.Number,
    token: Schema.NullOr(Schema.String),
    status: Schema.Literals(["none", "requested", "connected"]),
    connection: Schema.optional(Schema.Number),
    requestedAt: Schema.NullOr(Schema.Number),
    ensuredAt: Schema.NullOr(Schema.Number),
    startup: Schema.optional(
      Schema.Struct({
        retries: Schema.Number,
        deadline: Schema.Number,
        problem: Schema.optional(MachineStartupProblem),
      }),
    ),
    disconnectedAt: Schema.NullOr(Schema.Number),
    idleSince: Schema.NullOr(Schema.Number),
    ackedSequence: Schema.Number,
    machineClass: Schema.optional(MachineClass),
    movedUp: Schema.optional(Schema.Boolean),
    drains: Schema.optional(Schema.Boolean),
    steers: Schema.optional(Schema.Boolean),
    runtimeResponses: Schema.optional(Schema.Boolean),
    runtimeResponsesUpgrade: Schema.optional(Schema.Boolean),
    pulls: Schema.optional(Schema.Boolean),
    drain: Schema.optional(
      Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("asked"), id: Schema.Number }),
        Schema.Struct({
          _tag: Schema.Literal("answered"),
          id: Schema.Number,
          unsaved: Schema.Array(Schema.String),
        }),
      ]),
    ),
  }),
);
const encodeMachine = Schema.encodeSync(MachineLeaseJson);
const decodeMachineRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ lease: MachineLeaseJson })),
);

const MachineRecordJson = Schema.fromJsonString(
  Schema.Struct({
    machineId: Schema.NullOr(Schema.String),
    createKey: Schema.NullOr(Schema.String),
    setupKey: Schema.optionalKey(Schema.String),
    desired: Schema.Literals(["running", "stopped", "destroyed"]),
    settled: Schema.Boolean,
  }),
);
const encodeMachineRecord = Schema.encodeSync(MachineRecordJson);
const decodeMachineRecordRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ record: MachineRecordJson })),
);

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

  const owner: ThreadStore["Service"]["owner"] =
    sql`SELECT user_id, context_id, drive_id FROM owner`.pipe(
      Effect.map((rows) => {
        const [row] = decodeOwnerRows(rows);
        return row
          ? { userId: row.user_id, contextId: row.context_id, driveId: row.drive_id }
          : null;
      }),
    );

  // SQLite reads a negative limit as none.
  const events: ThreadStore["Service"]["events"] = (afterSequence, limit = -1) =>
    sql`SELECT sequence, format, event FROM events WHERE sequence > ${afterSequence}
      ORDER BY sequence LIMIT ${limit}`.pipe(
      Effect.map((rows) => decodeEventRows(rows).map(toStoredEvent)),
    );

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

  const machine: ThreadStore["Service"]["machine"] =
    sql`SELECT lease FROM machine WHERE id = 1`.pipe(
      Effect.map((rows) => decodeMachineRows(rows)[0]?.lease ?? NO_MACHINE),
    );

  const saveMachine: ThreadStore["Service"]["saveMachine"] = (lease) =>
    sql`INSERT INTO machine (id, lease) VALUES (1, ${encodeMachine(lease)})
      ON CONFLICT (id) DO UPDATE SET lease = excluded.lease`.pipe(Effect.asVoid);

  const machineRecord: ThreadStore["Service"]["machineRecord"] =
    sql`SELECT record FROM machine_record WHERE id = 1`.pipe(
      Effect.map((rows) => decodeMachineRecordRows(rows)[0]?.record ?? NO_MACHINE_RECORD),
    );

  const saveMachineRecord: ThreadStore["Service"]["saveMachineRecord"] = (record) =>
    sql`INSERT INTO machine_record (id, record) VALUES (1, ${encodeMachineRecord(record)})
      ON CONFLICT (id) DO UPDATE SET record = excluded.record`.pipe(Effect.asVoid);

  const commit: ThreadStore["Service"]["commit"] = Effect.fn("ThreadStore.commit")(function* (
    input,
  ) {
    const now = yield* Clock.currentTimeMillis;
    let sequence = input.head;
    for (const event of input.events) {
      sequence += 1;
      yield* sql`INSERT INTO events (sequence, command_id, format, event)
          VALUES (${sequence}, ${input.command?.id ?? null}, ${EVENT_FORMAT}, ${encodeEvent(event)})`;
      yield* recordCurrentItemState(sequence, event).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    }
    if (input.command) {
      yield* sql`INSERT INTO receipts
          (command_id, command_type, status, result_sequence, decided_at, trace_id)
          VALUES (${input.command.id}, ${input.command.type}, 'accepted', ${sequence}, ${now},
            ${input.command.traceId ?? null})`;
    }
    if (input.owner) {
      yield* sql`INSERT INTO owner (id, user_id, context_id, drive_id)
          VALUES (1, ${input.owner.userId}, ${input.owner.contextId}, ${input.owner.driveId})`;
    }
    if (input.summaryChanged) {
      // Past a revision its attached runs moved beyond the head, too.
      yield* sql`UPDATE outbox SET revision = MAX(${sequence}, revision + 1) WHERE id = 1`;
    }
    if (input.machine) yield* saveMachine(input.machine);
    if (input.events.length > 0 || (input.commandOutput?.length ?? 0) > 0) {
      yield* advanceCommandOutputSequence.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }
    yield* writeCommandOutput(input.commandOutputSeeds ?? [], input.commandOutput ?? []).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (input.instructions) {
      yield* sql`INSERT INTO run_instructions (run_id, levels)
          VALUES (${input.instructions.runId}, ${encodeInstructions(input.instructions.levels)})
          ON CONFLICT (run_id) DO NOTHING`;
    }
    if (input.secrets) {
      yield* sql`INSERT INTO thread_secrets (id, environments)
          VALUES (1, ${encodeSecrets(input.secrets)})
          ON CONFLICT (id) DO UPDATE SET environments = excluded.environments`;
    }
    return sequence;
  }, sql.withTransaction);

  const instructions: ThreadStore["Service"]["instructions"] = (runId) =>
    sql`SELECT levels FROM run_instructions WHERE run_id = ${runId}`.pipe(
      Effect.map((rows) => decodeInstructionRows(rows)[0]?.levels ?? []),
    );

  const secrets: ThreadStore["Service"]["secrets"] =
    sql`SELECT environments FROM thread_secrets WHERE id = 1`.pipe(
      Effect.map((rows) => decodeSecretRows(rows)[0]?.environments ?? []),
    );

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

  const eventsDelivered: ThreadStore["Service"]["eventsDelivered"] =
    sql`SELECT delivered FROM event_outbox WHERE id = 1`.pipe(
      Effect.map((rows) => decodeDeliveredRows(rows)[0]?.delivered ?? 0),
    );

  const acknowledgeEvents: ThreadStore["Service"]["acknowledgeEvents"] = (through) =>
    sql`INSERT INTO event_outbox (id, delivered) VALUES (1, ${through})
      ON CONFLICT (id) DO UPDATE SET delivered = MAX(delivered, excluded.delivered)`.pipe(
      Effect.asVoid,
    );

  const monitors: ThreadStore["Service"]["monitors"] =
    sql`SELECT monitors FROM thread_monitors WHERE id = 1`.pipe(
      Effect.map((rows) => decodeMonitorRows(rows)[0]?.monitors ?? []),
    );

  const saveMonitors: ThreadStore["Service"]["saveMonitors"] = Effect.fn(
    "ThreadStore.saveMonitors",
  )(function* (input) {
    yield* sql`INSERT INTO thread_monitors (id, monitors) VALUES (1, ${encodeMonitors(input.monitors)})
        ON CONFLICT (id) DO UPDATE SET monitors = excluded.monitors`;
    if (input.summaryChanged) yield* sql`UPDATE outbox SET revision = revision + 1 WHERE id = 1`;
  }, sql.withTransaction);

  const saveStatusNote = Effect.fn("ThreadStore.saveStatusNote")(function* (
    input: Parameters<ThreadStore["Service"]["saveStatusNote"]>[0],
  ) {
    yield* writeNote(input.note);
    if (input.summaryChanged) yield* sql`UPDATE outbox SET revision = revision + 1 WHERE id = 1`;
  }, sql.withTransaction);

  const initialized: ThreadStore["Service"]["initialized"] =
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  return ThreadStore.of({
    initialized,
    initialize: migrate.pipe(
      Effect.andThen(backfillCurrentItemState),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.asVoid,
    ),
    owner,
    events,
    receipt,
    commandOutputSequence: readCommandOutputSequence.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    ),
    commandOutput: (key) =>
      readCommandOutput(key).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    commit,
    recordRejection,
    outbox,
    acknowledgeSummary,
    eventsDelivered,
    acknowledgeEvents,
    monitors,
    saveMonitors,
    statusNote: readNote.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    saveStatusNote: (input) =>
      saveStatusNote(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    machine,
    saveMachine,
    machineRecord,
    instructions,
    secrets,
    secretValues: readSecretValues.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    registerSecretValues: (generation, values) =>
      registerSecretValues(generation, values).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    saveMachineRecord,
  });
});

export const layer = Layer.effect(ThreadStore, make);

/**
 * The machine record in this store. A thread that does not exist yet has no
 * tables and no machine.
 */
export const layerMachineRecords = Layer.effect(
  MachineRecords,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    // Tables, once created, stay: only a thread that does not exist yet asks again.
    let ready = false;
    return MachineRecords.of({
      get: Effect.orDie(
        Effect.suspend(() =>
          ready
            ? store.machineRecord
            : Effect.flatMap(store.initialized, (exists) => {
                ready = exists;
                return exists ? store.machineRecord : Effect.succeed(NO_MACHINE_RECORD);
              }),
        ),
      ),
      save: (record) => Effect.orDie(store.saveMachineRecord(record)),
    });
  }),
);
