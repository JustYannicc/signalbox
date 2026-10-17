import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

/** Independent of the sidebar outbox: cancellation must see even a just-created child. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE collaboration_tasks (
    child_thread_id TEXT PRIMARY KEY,
    parent_thread_id TEXT NOT NULL,
    stopped_through_ordinal INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX collaboration_tasks_parent ON collaboration_tasks (parent_thread_id)`;
});

export const makeTaskRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  return {
    lock,
    record: (parent: ThreadId, child: ThreadId) =>
      sql`INSERT INTO collaboration_tasks (child_thread_id, parent_thread_id)
        VALUES (${child}, ${parent}) ON CONFLICT (child_thread_id) DO NOTHING`,
    children: (parent: ThreadId) =>
      sql<{ readonly child_thread_id: ThreadId }>`SELECT child_thread_id FROM collaboration_tasks
        WHERE parent_thread_id = ${parent} ORDER BY child_thread_id`.pipe(
        Effect.map((rows) => rows.map((row) => row.child_thread_id)),
      ),
    stop: (child: ThreadId, ordinal: number) =>
      sql`UPDATE collaboration_tasks
        SET stopped_through_ordinal = MAX(stopped_through_ordinal, ${ordinal})
        WHERE child_thread_id = ${child}`,
    canDelegate: (parent: ThreadId, ordinal: number) =>
      sql<{ readonly stopped_through_ordinal: number }>`SELECT stopped_through_ordinal
        FROM collaboration_tasks WHERE child_thread_id = ${parent}`.pipe(
        Effect.map((rows) => rows[0] === undefined || rows[0].stopped_through_ordinal < ordinal),
      ),
  };
});

export type TaskRecords = Effect.Success<typeof makeTaskRecords>;
