import type { RetainedWorkflowScript } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  migrateWorkflowScripts,
  readWorkflowScript,
  retainWorkflowScripts,
} from "./workflowScripts.ts";
import { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";
import { MachineClass } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  CommandId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import {
  SearchDocument,
  SearchDocumentPart as SearchDocumentPartSchema,
  SearchThreadMetadata,
  type SearchDelivery,
  type SearchDocumentPart,
} from "../search/SearchIndex.ts";
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
import { PreparationState } from "./preparation/preparationState.ts";
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
import {
  SEARCH_DELIVERY_MAX_BYTES,
  boundSearchThreadMetadata,
  encodeSearchCoverageGap,
  boundedSearchDocumentParts,
  searchDeliveryBaseSize,
  searchDeliveryBytes,
  searchDeliveryWithinLimit,
  searchPartBytes,
  searchPartEscapedBytes,
  searchPartRowBytes,
  searchDeliveryRowBytes,
  searchRemovedItemBytes,
  searchRemovedItemEscapedBytes,
  splitSearchDocumentPart,
  splitSearchDocument,
  firstLegacyDeliveryCursor,
  takeLegacyDeliveryChunk,
  utf8Bytes,
} from "./searchOutboxParts.ts";

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

export interface ThreadTrashReceipt {
  readonly trashId: string;
  readonly generation: number;
  readonly deletedAt: number;
  readonly purgeAfter: number;
  readonly state: "trashed" | "restored";
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
  readonly preparations?: boolean | undefined;
  readonly workflowStops?: boolean | undefined;
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

export interface SearchOutboxState {
  readonly revision: number;
  readonly delivered: number;
  readonly backfillRequested: boolean;
  readonly backfillComplete: boolean;
  readonly backfillRevision: number;
  readonly backfillGeneration: number;
  readonly nextBackfillPage: number;
  readonly backfillSourceSequence: number;
  readonly backfillHome: SearchDelivery["home"] | null;
  readonly backfillThread: SearchDelivery["thread"] | null;
  readonly cursor: {
    readonly position: number;
    readonly itemId: string;
    readonly offset: number;
  } | null;
}

export interface SearchDeliveryDraft {
  readonly home: SearchDelivery["home"];
  readonly thread: SearchDelivery["thread"];
  readonly documents: ReadonlyArray<SearchDocument>;
  readonly parts?: ReadonlyArray<SearchDocumentPart>;
  readonly removed: ReadonlyArray<string>;
  readonly complete: boolean;
  readonly sourceSequence: number;
}

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    /** Whether the thread's tables exist. They are created with the thread, never before. */
    readonly workflowScript: (
      subagentId: NodeId,
      revision: string,
    ) => Effect.Effect<RetainedWorkflowScript | null, SqlError>;
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
      readonly scripts?: ReadonlyArray<RetainedWorkflowScript>;
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
      readonly preparation?: PreparationState;
      readonly commandOutputSeeds?: ReadonlyArray<CommandOutputKey>;
      readonly commandOutput?: ReadonlyArray<CommandOutputDelta>;
      /** The instructions of the thread's chain, for the run these events start. */
      readonly instructions?: {
        readonly runId: string;
        readonly levels: ReadonlyArray<FolderInstructions>;
      };
      /** The 1Password Environments of the thread's chain as of the run these events start. */
      readonly secrets?: ReadonlyArray<OnePasswordEnvironmentId>;
      /** Search rows are committed with the events that changed them. */
      readonly searchDeliveries?: ReadonlyArray<SearchDeliveryDraft>;
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
    readonly searchOutbox: Effect.Effect<SearchOutboxState, SqlError>;
    /** A durable packaging failure remains visible without keeping the alarm hot. */
    readonly hasUnpackageableSearch: Effect.Effect<boolean, SqlError>;
    readonly hasPendingSearchDelivery: Effect.Effect<boolean, SqlError>;
    readonly pendingSearchDelivery: Effect.Effect<SearchDelivery | null, SqlError>;
    readonly acknowledgeSearchDelivery: (
      revision: number,
      deliveryId: string,
    ) => Effect.Effect<void, SqlError>;
    readonly requestSearchBackfill: (input: {
      readonly home: SearchDelivery["home"];
      readonly thread: SearchDelivery["thread"];
      readonly documents: ReadonlyArray<SearchDocument>;
      readonly sourceSequence: number;
      readonly requestKey?: string;
    }) => Effect.Effect<SearchOutboxState, SqlError>;
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
    readonly preparation: Effect.Effect<PreparationState | null, SqlError>;
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
    readonly currentTrash: Effect.Effect<ThreadTrashReceipt | null, SqlError>;
    readonly beginTrash: (input: {
      readonly trashId: string;
      readonly deletedAt: number;
      readonly purgeAfter: number;
    }) => Effect.Effect<ThreadTrashReceipt, SqlError>;
    readonly restoreTrash: (trashId: string) => Effect.Effect<ThreadTrashReceipt | null, SqlError>;
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
  "0012_trash": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE thread_trash (
      trash_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      deleted_at INTEGER NOT NULL,
      purge_after INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('trashed', 'restored'))
    )`;
    yield* sql`CREATE TABLE thread_trash_current (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      trash_id TEXT NOT NULL
    )`;
  }),
  "0012_preparation": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE preparation (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`;
  }),
  "0012_workflow_scripts": migrateWorkflowScripts,
  "0012_command_output": migrateCommandOutput,
  "0012_git_pulls": migratePulls,
  "0012_current_item_history": migrateCurrentItemHistory,
  "0012_search_outbox": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE search_outbox_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      delivered INTEGER NOT NULL,
      backfill_requested INTEGER NOT NULL,
      backfill_complete INTEGER NOT NULL,
      backfill_revision INTEGER NOT NULL,
      backfill_generation INTEGER NOT NULL,
      next_backfill_page INTEGER NOT NULL,
      cursor_position INTEGER,
      cursor_item_id TEXT,
      backfill_source_sequence INTEGER NOT NULL,
      backfill_home_owner TEXT,
      backfill_home_project TEXT,
      backfill_thread TEXT
    )`;
    yield* sql`INSERT INTO search_outbox_state
      (id, revision, delivered, backfill_requested, backfill_complete, backfill_revision, backfill_generation, next_backfill_page, cursor_position, cursor_item_id, backfill_source_sequence)
      VALUES (1, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, 0)`;
    yield* sql`CREATE TABLE search_backfill_documents (
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (position, item_id)
    )`;
    yield* sql`CREATE TABLE search_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      revision INTEGER NOT NULL,
      page INTEGER NOT NULL,
      delivery_id TEXT NOT NULL UNIQUE,
      delivery TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX search_outbox_pending ON search_outbox (revision, page)`;
  }),
  "0013_current_item_expansion": migrateCurrentItemExpansion,
  "0013_search_outbox_parts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE search_outbox_state ADD COLUMN cursor_offset INTEGER`;
    yield* sql`UPDATE search_outbox_state SET cursor_offset = 9007199254740991
      WHERE cursor_position IS NOT NULL AND cursor_offset IS NULL`;
    yield* sql`ALTER TABLE search_outbox ADD COLUMN active INTEGER NOT NULL DEFAULT 1`;
    yield* sql`CREATE INDEX search_outbox_active_pending ON search_outbox (active, revision, page)`;
    yield* sql`CREATE TABLE search_backfill_document_parts (
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      offset INTEGER NOT NULL,
      part TEXT NOT NULL,
      PRIMARY KEY (position, item_id, offset)
    )`;
    yield* sql`CREATE TABLE search_backfill_activations (
      request_key TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      generation INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE search_outbox_conversion (
      revision INTEGER NOT NULL,
      page INTEGER NOT NULL,
      delivery_id TEXT NOT NULL,
      next_document INTEGER NOT NULL,
      next_offset INTEGER NOT NULL,
      next_removed INTEGER NOT NULL,
      next_page INTEGER NOT NULL,
      PRIMARY KEY (revision, delivery_id)
    )`;
    yield* sql`CREATE TABLE search_outbox_unpackageable (
      revision INTEGER PRIMARY KEY,
      reason TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE search_backfill_legacy_conversion (
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      next_offset INTEGER NOT NULL,
      PRIMARY KEY (position, item_id)
    )`;
  }),
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
const TrashRow = Schema.Struct({
  trash_id: Schema.String,
  generation: Schema.Number,
  deleted_at: Schema.Number,
  purge_after: Schema.Number,
  state: Schema.Literals(["trashed", "restored"]),
});
const ReceiptRow = Schema.Struct({
  status: Schema.Literals(["accepted", "rejected"]),
  result_sequence: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
});
const OutboxRow = Schema.Struct({ revision: Schema.Number, delivered: Schema.Number });
const decodeEventRows = Schema.decodeUnknownSync(Schema.Array(EventRow));
const decodeOwnerRows = Schema.decodeUnknownSync(Schema.Array(OwnerRow));
const decodeTrashRows = Schema.decodeUnknownSync(Schema.Array(TrashRow));
const decodeReceiptRows = Schema.decodeUnknownSync(Schema.Array(ReceiptRow));
const decodeOutboxRows = Schema.decodeUnknownSync(Schema.Array(OutboxRow));
const SearchDeliveryJson = Schema.fromJsonString(
  Schema.Struct({
    home: Schema.Struct({ ownerId: Schema.String, projectId: Schema.String }),
    thread: SearchThreadMetadata,
    revision: Schema.Number,
    sourceSequence: Schema.Number,
    deliveryId: Schema.String,
    documents: Schema.Array(SearchDocument),
    parts: Schema.optionalKey(Schema.Array(SearchDocumentPartSchema)),
    removed: Schema.Array(Schema.String),
    complete: Schema.Boolean,
    coverageGap: Schema.optionalKey(Schema.Boolean),
    snapshot: Schema.optionalKey(
      Schema.Struct({
        activation: Schema.String,
        page: Schema.Number,
        final: Schema.Boolean,
      }),
    ),
  }),
);
const encodeSearchDelivery = Schema.encodeSync(SearchDeliveryJson);
const SearchThreadJson = Schema.fromJsonString(SearchThreadMetadata);
const encodeSearchThread = Schema.encodeSync(SearchThreadJson);
const encodeSearchBackfillActivation = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      requestKey: Schema.String,
      revision: Schema.Number,
      generation: Schema.Number,
    }),
  ),
);
const decodeSearchThread = Schema.decodeUnknownSync(SearchThreadJson);
const decodeSearchDeliveryRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      revision: Schema.Number,
      page: Schema.Number,
      delivery_id: Schema.String,
      delivery: SearchDeliveryJson,
    }),
  ),
);
const SearchOutboxRow = Schema.Struct({
  revision: Schema.Number,
  delivered: Schema.Number,
  backfill_requested: Schema.Number,
  backfill_complete: Schema.Number,
  backfill_revision: Schema.Number,
  backfill_generation: Schema.Number,
  next_backfill_page: Schema.Number,
  cursor_position: Schema.NullOr(Schema.Number),
  cursor_item_id: Schema.NullOr(Schema.String),
  cursor_offset: Schema.NullOr(Schema.Number),
  backfill_source_sequence: Schema.Number,
  backfill_home_owner: Schema.NullOr(Schema.String),
  backfill_home_project: Schema.NullOr(Schema.String),
  backfill_thread: Schema.NullOr(Schema.String),
});
const decodeSearchOutboxRows = Schema.decodeUnknownSync(Schema.Array(SearchOutboxRow));
const decodeSearchPendingFlags = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ has_delivery: Schema.Number, has_conversion: Schema.Number })),
);
const decodeSearchBlockedFlags = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ blocked: Schema.Number })),
);
const SearchBackfillDocumentRow = Schema.Struct({
  position: Schema.Number,
  item_id: Schema.String,
  document: Schema.String,
});
const SearchBackfillDocumentJson = Schema.fromJsonString(SearchDocument);
const decodeSearchBackfillDocument = Schema.decodeUnknownSync(SearchBackfillDocumentJson);
const decodeSearchBackfillRows = Schema.decodeUnknownSync(Schema.Array(SearchBackfillDocumentRow));
const SearchBackfillPartJson = Schema.fromJsonString(SearchDocumentPartSchema);
const encodeSearchBackfillPart = Schema.encodeSync(SearchBackfillPartJson);
const decodeSearchBackfillPart = Schema.decodeUnknownSync(SearchBackfillPartJson);
const SearchBackfillPartRow = Schema.Struct({
  position: Schema.Number,
  item_id: Schema.String,
  offset: Schema.Number,
  part: Schema.String,
});
const decodeSearchBackfillPartRows = Schema.decodeUnknownSync(Schema.Array(SearchBackfillPartRow));
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
    preparations: Schema.optional(Schema.Boolean),
    workflowStops: Schema.optional(Schema.Boolean),
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
const PreparationJson = Schema.fromJsonString(PreparationState);
const encodePreparation = Schema.encodeSync(PreparationJson);
const decodePreparationRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ state: PreparationJson })),
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

  const preparation: ThreadStore["Service"]["preparation"] =
    sql`SELECT state FROM preparation WHERE id = 1`.pipe(
      Effect.map((rows) => decodePreparationRows(rows)[0]?.state ?? null),
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

  const markSearchUnpackageable = (
    revision: number,
    backfill = false,
    control?: Pick<SearchDelivery, "home" | "thread" | "sourceSequence"> & {
      readonly page: number;
    },
  ) =>
    Effect.gen(function* () {
      const existing = yield* sql`SELECT revision FROM search_outbox_unpackageable
        WHERE revision = ${revision}`;
      if (existing.length === 0) {
        yield* sql`INSERT INTO search_outbox_unpackageable (revision, reason)
          VALUES (${revision}, 'identity_metadata_exceeds_delivery_limit')`;
        yield* Effect.logWarning(
          "Search delivery cannot fit its outbox; source state is retained and search stays pending.",
          { revision },
        );
      }
      yield* sql`UPDATE search_outbox_state SET backfill_complete = 0 WHERE id = 1`;
      if (backfill) {
        yield* sql`UPDATE search_outbox_state SET backfill_requested = 0, backfill_complete = 0
          WHERE id = 1 AND backfill_revision = ${revision}`;
      }
      if (control === undefined) return;
      const marker = encodeSearchCoverageGap(control, revision, control.page, encodeSearchDelivery);
      if (marker === null) {
        // An untransportable home/thread identity cannot address the destination.
        // Retain the local failure without retrying an impossible envelope.
        yield* Effect.logWarning("Search coverage marker identity exceeds its delivery limit.", {
          revision,
        });
        return;
      }
      yield* sql`INSERT OR IGNORE INTO search_outbox (revision, page, delivery_id, delivery)
        VALUES (${revision}, ${control.page}, ${marker.delivery.deliveryId}, ${marker.encoded})`;
    });

  const markBackfillUnpackageable = (state: SearchOutboxState) =>
    markSearchUnpackageable(
      state.backfillRevision,
      true,
      state.backfillHome === null || state.backfillThread === null
        ? undefined
        : {
            home: state.backfillHome,
            thread: state.backfillThread,
            sourceSequence: state.backfillSourceSequence,
            page: -1,
          },
    );

  const commit: ThreadStore["Service"]["commit"] = Effect.fn("ThreadStore.commit")(function* (
    input,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const [searchStateRow] = decodeSearchOutboxRows(yield* readSearchOutboxState);
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
    const searchRevision =
      (searchStateRow?.revision ?? 0) + (input.searchDeliveries?.length ? 1 : 0);
    let page = 0;
    for (const draft of input.searchDeliveries ?? []) {
      // The full title is in the thread search document; this copy is repeated in every row.
      const cachedThread = boundSearchThreadMetadata(draft.thread);
      const markUnpackageable = Effect.gen(function* () {
        yield* markSearchUnpackageable(searchRevision, false, {
          home: draft.home,
          thread: cachedThread,
          sourceSequence: sequence,
          page: 1_000_000 + page,
        });
        page += 1;
      });
      const parts = [
        ...(draft.parts ?? []),
        ...draft.documents.flatMap((document) => splitSearchDocument(document)),
      ];
      let deliveryParts: Array<SearchDocumentPart> = [];
      let removed: Array<string> = [];
      let partsBytes = 0;
      let removedBytes = 0;
      let escapedPartsBytes = 0;
      let escapedRemovedBytes = 0;
      let baseSize = { envelope: 0, row: 0 };
      const makeDelivery = (complete: boolean): SearchDelivery => ({
        home: draft.home,
        thread: cachedThread,
        revision: searchRevision,
        sourceSequence: sequence,
        deliveryId: `${draft.thread.threadId}:${searchRevision}:source:${page}`,
        documents: [],
        parts: deliveryParts,
        removed,
        complete,
      });
      const hasContent = () => deliveryParts.length > 0 || removed.length > 0;
      const recalculateBase = () => {
        baseSize = searchDeliveryBaseSize(
          {
            home: draft.home,
            thread: cachedThread,
            revision: searchRevision,
            sourceSequence: sequence,
            deliveryId: `${draft.thread.threadId}:${searchRevision}:source:${page}`,
          },
          encodeSearchDelivery,
          1_000_000 + page,
        );
      };
      recalculateBase();
      if (!searchDeliveryWithinLimit(baseSize)) {
        yield* markUnpackageable;
        continue;
      }
      const emit = Effect.fnUntraced(function* (complete: boolean) {
        const delivery = makeDelivery(complete);
        const encoded = encodeSearchDelivery(delivery);
        const rowPage = 1_000_000 + page;
        if (
          utf8Bytes(encoded) > SEARCH_DELIVERY_MAX_BYTES ||
          searchDeliveryRowBytes(searchRevision, rowPage, delivery.deliveryId, encoded) >
            SEARCH_DELIVERY_MAX_BYTES
        ) {
          return yield* Effect.die(new Error("Search delivery exceeded its byte limit."));
        }
        yield* sql`INSERT INTO search_outbox (revision, page, delivery_id, delivery)
          VALUES (${searchRevision}, ${rowPage}, ${delivery.deliveryId}, ${encoded})`;
        page += 1;
        deliveryParts = [];
        removed = [];
        partsBytes = 0;
        removedBytes = 0;
        escapedPartsBytes = 0;
        escapedRemovedBytes = 0;
        recalculateBase();
      });
      let unpackageable = false;
      let partIndex = 0;
      while (partIndex < parts.length) {
        const part = parts[partIndex]!;
        const partBytes = searchPartBytes(part);
        const candidateBytes = searchDeliveryBytes(
          baseSize,
          partsBytes + partBytes,
          deliveryParts.length + 1,
          removedBytes,
          removed.length,
          escapedPartsBytes + searchPartEscapedBytes(part),
          escapedRemovedBytes,
        );
        if (!searchDeliveryWithinLimit(candidateBytes)) {
          if (hasContent()) {
            yield* emit(false);
            continue;
          }
          const split = splitSearchDocumentPart(part);
          if (split === null) {
            yield* markUnpackageable;
            unpackageable = true;
            break;
          }
          parts.splice(partIndex, 1, ...split);
          continue;
        }
        deliveryParts.push(part);
        partsBytes += partBytes;
        escapedPartsBytes += searchPartEscapedBytes(part);
        partIndex += 1;
      }
      if (unpackageable) continue;
      for (const itemId of draft.removed) {
        const itemBytes = searchRemovedItemBytes(itemId);
        const candidateBytes = searchDeliveryBytes(
          baseSize,
          partsBytes,
          deliveryParts.length,
          removedBytes + itemBytes,
          removed.length + 1,
          escapedPartsBytes,
          escapedRemovedBytes + searchRemovedItemEscapedBytes(itemId),
        );
        if (!searchDeliveryWithinLimit(candidateBytes)) {
          if (hasContent()) {
            yield* emit(false);
            const bytesAlone = searchDeliveryBytes(
              baseSize,
              0,
              0,
              itemBytes,
              1,
              0,
              searchRemovedItemEscapedBytes(itemId),
            );
            if (!searchDeliveryWithinLimit(bytesAlone)) {
              yield* markUnpackageable;
              unpackageable = true;
              break;
            }
          } else {
            yield* markUnpackageable;
            unpackageable = true;
            break;
          }
        }
        removed.push(itemId);
        removedBytes += itemBytes;
        escapedRemovedBytes += searchRemovedItemEscapedBytes(itemId);
      }
      if (unpackageable) continue;
      if (hasContent() || (parts.length === 0 && draft.removed.length === 0)) {
        yield* emit(draft.complete);
      }
    }
    if ((input.searchDeliveries?.length ?? 0) > 0) {
      yield* sql`UPDATE search_outbox_state SET revision = ${searchRevision} WHERE id = 1`;
    }
    if (input.summaryChanged) {
      // Past a revision its attached runs moved beyond the head, too.
      yield* sql`UPDATE outbox SET revision = MAX(${sequence}, revision + 1) WHERE id = 1`;
    }
    if (input.machine) yield* saveMachine(input.machine);
    if (input.preparation) {
      yield* sql`INSERT INTO preparation (id, state) VALUES (1, ${encodePreparation(input.preparation)})
        ON CONFLICT (id) DO UPDATE SET state = excluded.state`;
    }
    if (input.scripts)
      yield* retainWorkflowScripts(input.scripts).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
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

  const readSearchOutboxState = sql`
    SELECT revision, delivered, backfill_requested, backfill_complete, backfill_revision,
      backfill_generation, next_backfill_page, cursor_position, cursor_item_id, cursor_offset,
      backfill_source_sequence, backfill_home_owner, backfill_home_project, backfill_thread
    FROM search_outbox_state WHERE id = 1`;
  const decodeSearchOutboxState = (rows: unknown): SearchOutboxState => {
    const row = decodeSearchOutboxRows(rows)[0];
    return row === undefined
      ? {
          revision: 0,
          delivered: 0,
          backfillRequested: false,
          backfillComplete: false,
          backfillRevision: 0,
          backfillGeneration: 0,
          nextBackfillPage: 0,
          backfillSourceSequence: 0,
          backfillHome: null,
          backfillThread: null,
          cursor: null,
        }
      : {
          revision: row.revision,
          delivered: row.delivered,
          backfillRequested: row.backfill_requested === 1,
          backfillComplete: row.backfill_complete === 1,
          backfillRevision: row.backfill_revision,
          backfillGeneration: row.backfill_generation,
          nextBackfillPage: row.next_backfill_page,
          backfillSourceSequence: row.backfill_source_sequence,
          backfillHome:
            row.backfill_home_owner === null || row.backfill_home_project === null
              ? null
              : { ownerId: row.backfill_home_owner, projectId: row.backfill_home_project },
          backfillThread:
            row.backfill_thread === null ? null : decodeSearchThread(row.backfill_thread),
          cursor:
            row.cursor_position === null ||
            row.cursor_item_id === null ||
            row.cursor_offset === null
              ? null
              : {
                  position: row.cursor_position,
                  itemId: row.cursor_item_id,
                  offset: row.cursor_offset,
                },
        };
  };
  const searchOutbox: ThreadStore["Service"]["searchOutbox"] = readSearchOutboxState.pipe(
    Effect.map(decodeSearchOutboxState),
  );
  const hasPendingSearchDelivery: ThreadStore["Service"]["hasPendingSearchDelivery"] = sql`SELECT
      EXISTS (SELECT 1 FROM search_outbox WHERE active = 1) AS has_delivery,
      EXISTS (SELECT 1 FROM search_outbox_conversion) AS has_conversion`.pipe(
    Effect.map((rows) => {
      const [row] = decodeSearchPendingFlags(rows);
      return row !== undefined && (row.has_delivery === 1 || row.has_conversion === 1);
    }),
  );
  const hasUnpackageableSearch: ThreadStore["Service"]["hasUnpackageableSearch"] =
    sql`SELECT EXISTS (SELECT 1 FROM search_outbox_unpackageable) AS blocked`.pipe(
      Effect.map((rows) => {
        const [row] = decodeSearchBlockedFlags(rows);
        return row?.blocked === 1;
      }),
    );
  const pendingSearchDelivery: ThreadStore["Service"]["pendingSearchDelivery"] = Effect.gen(
    function* () {
      const state = decodeSearchOutboxState(yield* readSearchOutboxState);
      const activeRows = decodeSearchDeliveryRows(
        yield* sql`SELECT revision, page, delivery_id, delivery FROM search_outbox
          WHERE active = 1 ORDER BY revision, page LIMIT 1`,
      );
      const active = activeRows[0];
      const conversions = yield* sql<{
        readonly revision: number;
        readonly page: number;
        readonly delivery_id: string;
        readonly next_document: number;
        readonly next_offset: number;
        readonly next_removed: number;
        readonly next_page: number;
      }>`SELECT revision, page, delivery_id, next_document, next_offset, next_removed, next_page
        FROM search_outbox_conversion ORDER BY revision, page LIMIT 1`;
      const conversion = conversions[0];
      const conversionPage =
        conversion === undefined ? null : conversion.page + (conversion.next_page + 1) / 1_000_000;
      const conversionBeforeActive =
        conversion !== undefined &&
        (active === undefined ||
          active.revision > conversion.revision ||
          (active.revision === conversion.revision && active.page >= conversionPage!));

      if (
        conversion !== undefined &&
        conversionBeforeActive &&
        (!state.backfillRequested || conversion.revision <= state.backfillRevision)
      ) {
        const sourceRows = decodeSearchDeliveryRows(
          yield* sql`SELECT revision, page, delivery_id, delivery FROM search_outbox
            WHERE revision = ${conversion.revision} AND page = ${conversion.page}
              AND delivery_id = ${conversion.delivery_id} AND active = 0`,
        );
        const source = sourceRows[0]?.delivery;
        if (source === undefined) {
          yield* sql`DELETE FROM search_outbox_conversion
            WHERE revision = ${conversion.revision} AND delivery_id = ${conversion.delivery_id}`;
        } else {
          const deliveryId = `${source.deliveryId}:parts:${conversion.next_page}`;
          const page = conversion.page + (conversion.next_page + 1) / 1_000_000;
          const chunk = takeLegacyDeliveryChunk(
            source,
            {
              document: conversion.next_document,
              offset: conversion.next_offset,
              removed: conversion.next_removed,
            },
            deliveryId,
            page,
            encodeSearchDelivery,
          );
          const encoded = encodeSearchDelivery(chunk.delivery);
          yield* sql`INSERT INTO search_outbox (revision, page, delivery_id, delivery, active)
            VALUES (${chunk.delivery.revision}, ${page}, ${deliveryId}, ${encoded}, 1)`;
          if (chunk.done) {
            yield* sql`DELETE FROM search_outbox WHERE revision = ${conversion.revision}
              AND page = ${conversion.page} AND delivery_id = ${conversion.delivery_id}`;
            yield* sql`DELETE FROM search_outbox_conversion
              WHERE revision = ${conversion.revision} AND delivery_id = ${conversion.delivery_id}`;
          } else {
            yield* sql`UPDATE search_outbox_conversion SET next_document = ${chunk.cursor.document},
              next_offset = ${chunk.cursor.offset}, next_removed = ${chunk.cursor.removed},
              next_page = ${conversion.next_page + 1}
              WHERE revision = ${conversion.revision} AND delivery_id = ${conversion.delivery_id}`;
          }
          return chunk.delivery;
        }
      }
      if (
        active !== undefined &&
        (!state.backfillRequested || active.revision <= state.backfillRevision)
      ) {
        const delivery = active.delivery;
        const encoded = encodeSearchDelivery(delivery);
        if (
          delivery.documents.length === 0 &&
          utf8Bytes(encoded) <= SEARCH_DELIVERY_MAX_BYTES &&
          searchDeliveryRowBytes(active.revision, active.page, active.delivery_id, encoded) <=
            SEARCH_DELIVERY_MAX_BYTES
        ) {
          return delivery;
        }
        yield* sql`UPDATE search_outbox SET active = 0 WHERE revision = ${active.revision}
          AND page = ${active.page} AND delivery_id = ${active.delivery_id} AND active = 1`;
        yield* sql`INSERT INTO search_outbox_conversion
          (revision, page, delivery_id, next_document, next_offset, next_removed, next_page)
          VALUES (${active.revision}, ${active.page}, ${active.delivery_id}, 0, 0, 0, 0)`;
        const deliveryId = `${delivery.deliveryId}:parts:0`;
        const page = active.page + 1 / 1_000_000;
        const chunk = takeLegacyDeliveryChunk(
          delivery,
          firstLegacyDeliveryCursor,
          deliveryId,
          page,
          encodeSearchDelivery,
        );
        const chunkEncoded = encodeSearchDelivery(chunk.delivery);
        yield* sql`INSERT INTO search_outbox (revision, page, delivery_id, delivery, active)
          VALUES (${delivery.revision}, ${page}, ${deliveryId}, ${chunkEncoded}, 1)`;
        if (chunk.done) {
          yield* sql`DELETE FROM search_outbox WHERE revision = ${active.revision}
            AND page = ${active.page} AND delivery_id = ${active.delivery_id}`;
          yield* sql`DELETE FROM search_outbox_conversion
            WHERE revision = ${active.revision} AND delivery_id = ${active.delivery_id}`;
        } else {
          yield* sql`UPDATE search_outbox_conversion SET next_document = ${chunk.cursor.document},
            next_offset = ${chunk.cursor.offset}, next_removed = ${chunk.cursor.removed}, next_page = 1
            WHERE revision = ${active.revision} AND delivery_id = ${active.delivery_id}`;
        }
        return chunk.delivery;
      }
      if (
        !state.backfillRequested ||
        state.backfillHome === null ||
        state.backfillThread === null
      ) {
        return active?.delivery ?? null;
      }

      const cursor = state.cursor;
      const legacyConversions = yield* sql<{
        readonly position: number;
        readonly item_id: string;
        readonly next_offset: number;
      }>`SELECT position, item_id, next_offset FROM search_backfill_legacy_conversion
        ORDER BY position, item_id LIMIT 1`;
      let legacyConversion = legacyConversions[0];
      if (legacyConversion === undefined) {
        const legacyRows = decodeSearchBackfillRows(
          yield* sql`SELECT position, item_id, document FROM search_backfill_documents
            WHERE (${cursor === null ? 1 : 0} = 1 OR position > ${cursor?.position ?? 0}
              OR (position = ${cursor?.position ?? 0} AND item_id > ${cursor?.itemId ?? ""}))
            ORDER BY position, item_id LIMIT 1`,
        );
        const legacy = legacyRows[0];
        if (legacy !== undefined) {
          yield* sql`INSERT INTO search_backfill_legacy_conversion (position, item_id, next_offset)
            VALUES (${legacy.position}, ${legacy.item_id}, 0)`;
          legacyConversion = {
            position: legacy.position,
            item_id: legacy.item_id,
            next_offset: 0,
          };
        }
      }
      if (legacyConversion !== undefined) {
        const legacyRows = decodeSearchBackfillRows(
          yield* sql`SELECT position, item_id, document FROM search_backfill_documents
            WHERE position = ${legacyConversion.position} AND item_id = ${legacyConversion.item_id}`,
        );
        const legacy = legacyRows[0];
        if (legacy === undefined) {
          yield* sql`DELETE FROM search_backfill_legacy_conversion
            WHERE position = ${legacyConversion.position} AND item_id = ${legacyConversion.item_id}`;
        } else {
          const document = decodeSearchBackfillDocument(legacy.document);
          const converted = boundedSearchDocumentParts(
            document,
            legacyConversion.next_offset,
            SEARCH_DELIVERY_MAX_BYTES / 2,
          );
          if (converted.blocked) {
            yield* markBackfillUnpackageable(state);
            return null;
          }
          let finished = document.text.length === 0 || converted.nextOffset >= document.text.length;
          for (const part of converted.parts) {
            const encoded = encodeSearchBackfillPart(part);
            if (
              searchPartRowBytes(part.position, part.itemId, part.offset, encoded) >
              SEARCH_DELIVERY_MAX_BYTES
            ) {
              return yield* Effect.die(
                new Error("A converted backfill row exceeds its byte limit."),
              );
            }
            yield* sql`INSERT INTO search_backfill_document_parts (position, item_id, offset, part)
              VALUES (${part.position}, ${part.itemId}, ${part.offset}, ${encoded})`;
          }
          if (finished) {
            yield* sql`DELETE FROM search_backfill_documents
              WHERE position = ${legacy.position} AND item_id = ${legacy.item_id}`;
            yield* sql`DELETE FROM search_backfill_legacy_conversion
              WHERE position = ${legacy.position} AND item_id = ${legacy.item_id}`;
          } else {
            yield* sql`UPDATE search_backfill_legacy_conversion SET next_offset = ${converted.nextOffset}
              WHERE position = ${legacy.position} AND item_id = ${legacy.item_id}`;
          }
        }
      }

      const rows = decodeSearchBackfillPartRows(
        yield* sql`SELECT position, item_id, offset, part FROM search_backfill_document_parts
          WHERE (${cursor === null ? 1 : 0} = 1 OR position > ${cursor?.position ?? 0}
            OR (position = ${cursor?.position ?? 0} AND item_id > ${cursor?.itemId ?? ""})
            OR (position = ${cursor?.position ?? 0} AND item_id = ${cursor?.itemId ?? ""}
              AND offset > ${cursor?.offset ?? 0}))
          ORDER BY position, item_id, offset LIMIT 64`,
      );
      const parts: Array<SearchDocumentPart> = [];
      const page = state.nextBackfillPage;
      const deliveryId = `${state.backfillThread.threadId}:${state.backfillRevision}:backfill:${state.backfillGeneration}:${page}`;
      const activationRows = yield* sql<{ readonly request_key: string }>`SELECT request_key
        FROM search_backfill_activations
        WHERE generation = ${state.backfillGeneration} AND revision = ${state.backfillRevision}`;
      const snapshot = {
        activation:
          activationRows[0]?.request_key ??
          `search-backfill:${state.backfillThread.threadId}:${state.backfillGeneration}`,
        page,
        final: false,
      } as const;
      const base = {
        home: state.backfillHome,
        thread: state.backfillThread,
        revision: state.backfillRevision,
        sourceSequence: state.backfillSourceSequence,
        deliveryId,
        snapshot,
      };
      const baseSize = searchDeliveryBaseSize(base, encodeSearchDelivery, page);
      if (!searchDeliveryWithinLimit(baseSize)) {
        yield* markBackfillUnpackageable(state);
        return null;
      }
      let partsBytes = 0;
      let escapedPartsBytes = 0;
      for (const row of rows) {
        const part = decodeSearchBackfillPart(row.part);
        const nextSize = searchDeliveryBytes(
          baseSize,
          partsBytes + searchPartBytes(part),
          parts.length + 1,
          0,
          0,
          escapedPartsBytes + searchPartEscapedBytes(part),
          0,
        );
        if (!searchDeliveryWithinLimit(nextSize)) {
          if (parts.length === 0) {
            const split = splitSearchDocumentPart(part);
            if (split === null) {
              yield* markBackfillUnpackageable(state);
              return null;
            }
            yield* sql`DELETE FROM search_backfill_document_parts
              WHERE position = ${part.position} AND item_id = ${part.itemId} AND offset = ${part.offset}`;
            for (const piece of split) {
              const encoded = encodeSearchBackfillPart(piece);
              yield* sql`INSERT INTO search_backfill_document_parts (position, item_id, offset, part)
                VALUES (${piece.position}, ${piece.itemId}, ${piece.offset}, ${encoded})
                ON CONFLICT (position, item_id, offset) DO NOTHING`;
            }
            return null;
          }
          break;
        }
        parts.push(part);
        partsBytes += searchPartBytes(part);
        escapedPartsBytes += searchPartEscapedBytes(part);
      }
      const lastPart = parts.at(-1);
      const partCursor = lastPart ?? cursor;
      const hasMoreRows =
        (yield* sql`SELECT offset FROM search_backfill_document_parts
        WHERE ${partCursor === null ? 1 : 0} = 1
          OR position > ${partCursor?.position ?? 0}
          OR (position = ${partCursor?.position ?? 0} AND item_id > ${partCursor?.itemId ?? ""})
          OR (position = ${partCursor?.position ?? 0} AND item_id = ${partCursor?.itemId ?? ""}
            AND offset > ${partCursor?.offset ?? 0})
        ORDER BY position, item_id, offset LIMIT 1`).length > 0;
      const hasMoreLegacy =
        (yield* sql`SELECT position FROM search_backfill_documents
        WHERE ${partCursor === null ? 1 : 0} = 1
          OR position > ${partCursor?.position ?? 0}
          OR (position = ${partCursor?.position ?? 0} AND item_id >= ${partCursor?.itemId ?? ""})
        ORDER BY position, item_id LIMIT 1`).length > 0;
      const complete = !hasMoreRows && !hasMoreLegacy;
      const delivery: SearchDelivery = {
        home: state.backfillHome,
        thread: state.backfillThread,
        revision: state.backfillRevision,
        sourceSequence: state.backfillSourceSequence,
        deliveryId,
        documents: [],
        parts,
        removed: [],
        complete,
        snapshot: { ...snapshot, final: complete },
      };
      const encoded = encodeSearchDelivery(delivery);
      if (
        utf8Bytes(encoded) > SEARCH_DELIVERY_MAX_BYTES ||
        searchDeliveryRowBytes(state.backfillRevision, page, deliveryId, encoded) >
          SEARCH_DELIVERY_MAX_BYTES
      ) {
        return yield* Effect.die(new Error("A backfill delivery exceeds the byte limit."));
      }
      yield* sql`INSERT INTO search_outbox (revision, page, delivery_id, delivery, active)
        VALUES (${state.backfillRevision}, ${page}, ${delivery.deliveryId}, ${encoded}, 1)`;
      yield* sql`UPDATE search_outbox_state SET next_backfill_page = ${page + 1},
        cursor_position = ${complete || lastPart === undefined ? null : lastPart.position},
        cursor_item_id = ${complete || lastPart === undefined ? null : lastPart.itemId},
        cursor_offset = ${complete || lastPart === undefined ? null : lastPart.offset}
        WHERE id = 1`;
      return delivery;
    },
  ).pipe(sql.withTransaction);
  const acknowledgeSearchDelivery: ThreadStore["Service"]["acknowledgeSearchDelivery"] = (
    revision,
    deliveryId,
  ) =>
    Effect.gen(function* () {
      const [row] = decodeSearchDeliveryRows(
        yield* sql`SELECT revision, page, delivery_id, delivery FROM search_outbox
          WHERE revision = ${revision} AND delivery_id = ${deliveryId} AND active = 1`,
      );
      if (row === undefined) return;
      yield* sql`DELETE FROM search_outbox WHERE revision = ${revision} AND delivery_id = ${deliveryId}`;
      yield* sql`UPDATE search_outbox_state SET delivered = MAX(delivered, ${revision}) WHERE id = 1`;
      if (
        row.delivery.complete &&
        row.delivery.snapshot?.final === true &&
        revision === decodeSearchOutboxState(yield* readSearchOutboxState).backfillRevision
      ) {
        yield* sql`UPDATE search_outbox_state SET backfill_requested = 0,
          backfill_complete = CASE WHEN EXISTS (
            SELECT 1 FROM search_outbox_unpackageable WHERE revision > ${revision}
          ) THEN 0 ELSE 1 END,
          cursor_position = NULL, cursor_item_id = NULL, backfill_home_owner = NULL,
          cursor_offset = NULL, backfill_home_project = NULL, backfill_thread = NULL WHERE id = 1`;
        yield* sql`DELETE FROM search_backfill_documents`;
        yield* sql`DELETE FROM search_backfill_document_parts`;
        yield* sql`DELETE FROM search_backfill_legacy_conversion`;
        yield* sql`DELETE FROM search_outbox_unpackageable WHERE revision <= ${revision}`;
      }
    }).pipe(sql.withTransaction);

  const requestSearchBackfill: ThreadStore["Service"]["requestSearchBackfill"] = (input) =>
    Effect.gen(function* () {
      const state = decodeSearchOutboxState(yield* readSearchOutboxState);
      if (input.requestKey !== undefined) {
        const seen = yield* sql`SELECT request_key FROM search_backfill_activations
          WHERE request_key = ${input.requestKey}`;
        if (seen.length > 0) return state;
      } else if (state.backfillRequested) {
        return state;
      }
      const generation = state.backfillGeneration + 1;
      const revision = state.revision + 1;
      const cachedThread = boundSearchThreadMetadata(input.thread);
      yield* sql`DELETE FROM search_backfill_documents`;
      yield* sql`DELETE FROM search_backfill_document_parts`;
      yield* sql`DELETE FROM search_backfill_legacy_conversion`;
      const blockBackfill = Effect.gen(function* () {
        yield* sql`UPDATE search_outbox_state SET revision = ${revision}, backfill_requested = 1,
        backfill_complete = 0, backfill_revision = ${revision}, backfill_generation = ${generation},
        next_backfill_page = 0, cursor_position = NULL, cursor_item_id = NULL, cursor_offset = NULL,
        backfill_source_sequence = ${input.sourceSequence}, backfill_home_owner = ${input.home.ownerId},
        backfill_home_project = ${input.home.projectId}, backfill_thread = ${encodeSearchThread(cachedThread)}
        WHERE id = 1`;
        if (input.requestKey !== undefined) {
          yield* sql`INSERT INTO search_backfill_activations (request_key, revision, generation)
          VALUES (${input.requestKey}, ${revision}, ${generation})`;
        }
        yield* markSearchUnpackageable(revision, true, {
          home: input.home,
          thread: cachedThread,
          sourceSequence: input.sourceSequence,
          page: -1,
        });
        return {
          revision,
          delivered: state.delivered,
          backfillRequested: false,
          backfillComplete: false,
          backfillRevision: revision,
          backfillGeneration: generation,
          nextBackfillPage: 0,
          backfillSourceSequence: input.sourceSequence,
          backfillHome: input.home,
          backfillThread: cachedThread,
          cursor: null,
        } satisfies SearchOutboxState;
      });
      for (const document of input.documents) {
        let offset = 0;
        do {
          const converted = boundedSearchDocumentParts(
            document,
            offset,
            SEARCH_DELIVERY_MAX_BYTES / 2,
          );
          if (converted.blocked) return yield* blockBackfill;
          for (const part of converted.parts) {
            const encoded = encodeSearchBackfillPart(part);
            if (
              searchPartRowBytes(part.position, part.itemId, part.offset, encoded) >
              SEARCH_DELIVERY_MAX_BYTES
            ) {
              return yield* blockBackfill;
            }
            yield* sql`INSERT INTO search_backfill_document_parts (position, item_id, offset, part)
            VALUES (${part.position}, ${part.itemId}, ${part.offset}, ${encoded})`;
          }
          if (document.text.length === 0) break;
          offset = converted.nextOffset;
        } while (offset < document.text.length);
      }
      if (input.requestKey !== undefined) {
        if (
          utf8Bytes(
            encodeSearchBackfillActivation({ requestKey: input.requestKey, revision, generation }),
          ) > SEARCH_DELIVERY_MAX_BYTES
        ) {
          return yield* Effect.die(
            new Error("A backfill request key exceeds its storage byte limit."),
          );
        }
        yield* sql`INSERT INTO search_backfill_activations (request_key, revision, generation)
          VALUES (${input.requestKey}, ${revision}, ${generation})`;
      }
      yield* sql`UPDATE search_outbox_state SET revision = ${revision}, backfill_requested = 1,
        backfill_complete = 0, backfill_revision = ${revision}, backfill_generation = ${generation},
        next_backfill_page = 0, cursor_position = NULL, cursor_item_id = NULL, cursor_offset = NULL,
        backfill_source_sequence = ${input.sourceSequence}, backfill_home_owner = ${input.home.ownerId},
        backfill_home_project = ${input.home.projectId}, backfill_thread = ${encodeSearchThread(cachedThread)}
        WHERE id = 1`;
      return {
        revision,
        delivered: state.delivered,
        backfillRequested: true,
        backfillComplete: false,
        backfillRevision: revision,
        backfillGeneration: generation,
        nextBackfillPage: 0,
        backfillSourceSequence: input.sourceSequence,
        backfillHome: input.home,
        backfillThread: cachedThread,
        cursor: null,
      } satisfies SearchOutboxState;
    }).pipe(sql.withTransaction);

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

  const toTrashReceipt = (row: typeof TrashRow.Type): ThreadTrashReceipt => ({
    trashId: row.trash_id,
    generation: row.generation,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    state: row.state,
  });

  const readTrash = (trashId: string) =>
    sql`SELECT trash_id, generation, deleted_at, purge_after, state
      FROM thread_trash WHERE trash_id = ${trashId}`.pipe(
      Effect.map((rows) => decodeTrashRows(rows).map(toTrashReceipt)[0] ?? null),
    );

  const currentTrash: ThreadStore["Service"]["currentTrash"] = Effect.gen(function* () {
    const rows = yield* sql`SELECT trash_id FROM thread_trash_current WHERE id = 1`;
    const trashId = (rows[0] as { readonly trash_id?: string } | undefined)?.trash_id;
    return trashId === undefined ? null : yield* readTrash(trashId);
  });

  const beginTrash: ThreadStore["Service"]["beginTrash"] = Effect.fn("ThreadStore.beginTrash")(
    function* (input) {
      const existing = yield* readTrash(input.trashId);
      if (existing !== null) return existing;
      const current = yield* currentTrash;
      if (current?.state === "trashed") return current;
      const next: ThreadTrashReceipt = {
        trashId: input.trashId,
        generation: (current?.generation ?? 0) + 1,
        deletedAt: input.deletedAt,
        purgeAfter: input.purgeAfter,
        state: "trashed",
      };
      yield* sql`INSERT INTO thread_trash
        (trash_id, generation, deleted_at, purge_after, state)
        VALUES (${next.trashId}, ${next.generation}, ${next.deletedAt}, ${next.purgeAfter}, ${next.state})`;
      yield* sql`INSERT INTO thread_trash_current (id, trash_id) VALUES (1, ${next.trashId})
        ON CONFLICT (id) DO UPDATE SET trash_id = excluded.trash_id`;
      return next;
    },
    sql.withTransaction,
  );

  const restoreTrash: ThreadStore["Service"]["restoreTrash"] = Effect.fn(
    "ThreadStore.restoreTrash",
  )(function* (trashId) {
    const existing = yield* readTrash(trashId);
    if (existing === null || existing.state === "restored") return existing;
    const next = { ...existing, state: "restored" as const };
    yield* sql`UPDATE thread_trash SET state = 'restored' WHERE trash_id = ${trashId}`;
    return next;
  }, sql.withTransaction);

  const initialized: ThreadStore["Service"]["initialized"] =
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  return ThreadStore.of({
    preparation,
    workflowScript: (subagentId, revision) =>
      readWorkflowScript(subagentId, revision).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
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
    searchOutbox,
    hasUnpackageableSearch,
    hasPendingSearchDelivery,
    pendingSearchDelivery,
    acknowledgeSearchDelivery,
    requestSearchBackfill,
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
    currentTrash,
    beginTrash,
    restoreTrash,
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
