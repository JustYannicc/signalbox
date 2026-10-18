import { CheckpointViews } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Tables and codecs for immutable drive checkpoints and revision operations. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE threads ADD COLUMN notes_oid TEXT`;
  yield* sql`ALTER TABLE threads ADD COLUMN pinned_views TEXT`;
  yield* sql`ALTER TABLE threads ADD COLUMN revision TEXT`;
  yield* sql`CREATE TABLE drive_checkpoints (
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    start_oid TEXT,
    notes_oid TEXT NOT NULL,
    views_json TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, run_id)
  )`;
  yield* sql`CREATE TABLE drive_revision_operations (
    thread_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, operation_id)
  )`;
});

/** Restore undo snapshots are separate so drives that already ran 0007 upgrade safely. */
export const createRestoreTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_restore_snapshots (
    thread_id TEXT NOT NULL,
    restore_operation_id TEXT NOT NULL,
    before_thread_oid TEXT,
    before_wip_oid TEXT,
    before_pinned_views TEXT,
    before_revision TEXT,
    restored_pinned_views TEXT NOT NULL,
    restored_revision TEXT NOT NULL,
    restored_generation INTEGER NOT NULL,
    undone_by TEXT,
    PRIMARY KEY (thread_id, restore_operation_id)
  )`;
});

export const addOperationRequester = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE drive_revision_operations ADD COLUMN requester_id TEXT`;
});

const ViewsJson = Schema.fromJsonString(CheckpointViews);
export const encodeViews = Schema.encodeSync(ViewsJson);
export const decodeViews = Schema.decodeUnknownSync(ViewsJson);

const ForkRequestJson = Schema.fromJsonString(
  Schema.Struct({ sourceThreadId: Schema.String, runId: Schema.String, threadId: Schema.String }),
);
export const encodeForkRequest = Schema.encodeSync(ForkRequestJson);

const RestoreRequestJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    runId: Schema.String,
    expectedThread: Schema.NullOr(Schema.String),
    expectedWip: Schema.NullOr(Schema.String),
    generation: Schema.Number,
    boundary: Schema.optional(Schema.Literals(["start", "end"])),
  }),
);
export const encodeRestoreRequest = Schema.encodeSync(RestoreRequestJson);

const UndoRestoreRequestJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    restoreOperationId: Schema.String,
    expectedThread: Schema.NullOr(Schema.String),
    expectedWip: Schema.NullOr(Schema.String),
    generation: Schema.Number,
  }),
);
export const encodeUndoRestoreRequest = Schema.encodeSync(UndoRestoreRequestJson);

const UpdateToLatestRequestJson = Schema.fromJsonString(
  Schema.Struct({
    threadId: Schema.String,
    expectedThread: Schema.NullOr(Schema.String),
    expectedWip: Schema.NullOr(Schema.String),
    generation: Schema.Number,
  }),
);
export const encodeUpdateToLatestRequest = Schema.encodeSync(UpdateToLatestRequestJson);

export const checkpointRef = (threadId: string, runId: string) =>
  `signalbox/checkpoints/${encodeURIComponent(threadId)}/${encodeURIComponent(runId)}`;

export const checkpointNotesRef = (threadId: string, runId: string) =>
  `signalbox/notes/checkpoints/${encodeURIComponent(threadId)}/${encodeURIComponent(runId)}`;

export const restoreSnapshotRef = (threadId: string, operationId: string, head: "thread" | "wip") =>
  `signalbox/restores/${encodeURIComponent(threadId)}/${encodeURIComponent(operationId)}/before-${head}`;

export const restoreUndoRef = (threadId: string, operationId: string, head: "thread" | "wip") =>
  `signalbox/restore-undos/${encodeURIComponent(threadId)}/${encodeURIComponent(operationId)}/${head}`;

export const notesRef = (threadId: string) => `signalbox/notes/${encodeURIComponent(threadId)}`;

export const CheckpointRow = Schema.Struct({
  thread_id: Schema.String,
  run_id: Schema.String,
  turn_id: Schema.String,
  commit_oid: Schema.String,
  start_oid: Schema.NullOr(Schema.String),
  notes_oid: Schema.String,
  views_json: Schema.String,
  generation: Schema.Number,
});
export const decodeCheckpointRows = Schema.decodeUnknownSync(Schema.Array(CheckpointRow));

export const OperationRow = Schema.Struct({
  kind: Schema.String,
  request_json: Schema.String,
  requester_id: Schema.NullOr(Schema.String),
});
export const decodeOperationRows = Schema.decodeUnknownSync(Schema.Array(OperationRow));

export const RestoreSnapshotRow = Schema.Struct({
  before_thread_oid: Schema.NullOr(Schema.String),
  before_wip_oid: Schema.NullOr(Schema.String),
  before_pinned_views: Schema.NullOr(Schema.String),
  before_revision: Schema.NullOr(Schema.String),
  restored_pinned_views: Schema.String,
  restored_revision: Schema.String,
  restored_generation: Schema.Number,
  undone_by: Schema.NullOr(Schema.String),
});
export const decodeRestoreSnapshotRows = Schema.decodeUnknownSync(Schema.Array(RestoreSnapshotRow));

export const ThreadRevisionRow = Schema.Struct({
  base: Schema.NullOr(Schema.String),
  generation: Schema.Number,
  notes_oid: Schema.NullOr(Schema.String),
  pinned_views: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
});
