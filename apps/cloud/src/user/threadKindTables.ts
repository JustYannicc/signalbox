import { ThreadId } from "@t3tools/contracts";
import {
  DEFAULT_ARCHIVE_CHATS_AFTER_DAYS,
  ThreadKind,
  type ThreadKindRecord,
} from "@t3tools/contracts/signalboxThreadKinds";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `UserStore`'s `0014` migration: chat and task kinds (`UserThreadKinds`).
 * A thread without a row is a task, so every thread from before stays one
 * and never archives itself.
 */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_kinds (
    thread_id TEXT PRIMARY KEY,
    classified TEXT,
    override TEXT,
    work_started_at INTEGER,
    updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE thread_kind_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    archive_chats_after_days INTEGER
  )`;
  yield* sql`INSERT INTO thread_kind_settings (id, archive_chats_after_days)
    VALUES (1, ${DEFAULT_ARCHIVE_CHATS_AFTER_DAYS})`;
});

/** A `thread_kinds` row as stored. */
export const RecordRow = Schema.Struct({
  thread_id: ThreadId,
  classified: Schema.NullOr(ThreadKind),
  override: Schema.NullOr(ThreadKind),
  work_started_at: Schema.NullOr(Schema.Number),
});
export const decodeRecords = Schema.decodeUnknownSync(Schema.Array(RecordRow));

export const toRecord = (row: typeof RecordRow.Type): ThreadKindRecord => ({
  threadId: row.thread_id,
  classified: row.classified,
  override: row.override,
  workStartedAt: row.work_started_at === null ? null : DateTime.makeUnsafe(row.work_started_at),
});
