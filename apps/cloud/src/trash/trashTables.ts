import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  TrashPlannedRemoval,
  type TrashPlannedRemoval as TrashPlannedRemovalType,
} from "@t3tools/contracts/signalboxTrash";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RETRY_MS = 60_000;

export const migrateTrash = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE trash_entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    title TEXT NOT NULL,
    context_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    purge_after INTEGER NOT NULL,
    status TEXT NOT NULL,
    targets TEXT NOT NULL,
    drive_ids TEXT NOT NULL DEFAULT '[]',
    planned_removals TEXT NOT NULL DEFAULT '[]',
    removals TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    scheduled INTEGER NOT NULL DEFAULT 0,
    prepared INTEGER NOT NULL DEFAULT 0,
    gc_after INTEGER,
    restore_started_at INTEGER
  )`;
  yield* sql`CREATE UNIQUE INDEX trash_active_target ON trash_entries (kind, target_id)
    WHERE status IN ('trashed', 'restoring', 'purging')`;
  yield* sql`CREATE INDEX trash_pending ON trash_entries (status, scheduled, purge_after)`;
  yield* sql`CREATE TABLE trash_requests (
    command_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    trash_id TEXT NOT NULL
  )`;
});

export const Target = Schema.Struct({
  threadId: Schema.String,
  driveId: Schema.NullOr(Schema.String),
});
export type Target = typeof Target.Type;
export const Removal = Schema.Struct({ kind: Schema.String, id: Schema.String });
export type Removal = typeof Removal.Type;

export const Row = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["thread", "folder"]),
  target_id: Schema.String,
  title: Schema.String,
  context_id: Schema.String,
  deleted_at: Schema.Number,
  purge_after: Schema.Number,
  status: Schema.Literals(["trashed", "restoring", "purging", "purged", "restored"]),
  targets: Schema.fromJsonString(Schema.Array(Target)),
  drive_ids: Schema.fromJsonString(Schema.Array(Schema.String)),
  planned_removals: Schema.fromJsonString(Schema.Array(TrashPlannedRemoval)),
  removals: Schema.fromJsonString(Schema.Array(Removal)),
  error: Schema.NullOr(Schema.String),
  scheduled: Schema.Number,
  prepared: Schema.Number,
  gc_after: Schema.NullOr(Schema.Number),
  restore_started_at: Schema.NullOr(Schema.Number),
});
export type Row = typeof Row.Type;
export const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row));
export const encodeTargets = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Target)));
export const encodePlannedRemovals = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(TrashPlannedRemoval)),
);
export const encodeRemovals = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Removal)));
export type PlannedRemoval = TrashPlannedRemovalType;
