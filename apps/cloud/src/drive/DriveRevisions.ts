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
  }),
);
export const encodeRestoreRequest = Schema.encodeSync(RestoreRequestJson);

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
});
export const decodeOperationRows = Schema.decodeUnknownSync(Schema.Array(OperationRow));

export const ThreadRevisionRow = Schema.Struct({
  base: Schema.NullOr(Schema.String),
  generation: Schema.Number,
  notes_oid: Schema.NullOr(Schema.String),
  pinned_views: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
});
