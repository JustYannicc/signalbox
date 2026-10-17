import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { CollaborationError } from "./errors.ts";

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

export const createRunLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE collaboration_task_runs (
    parent_thread_id TEXT NOT NULL,
    parent_ordinal INTEGER NOT NULL,
    child_thread_id TEXT NOT NULL,
    child_through_ordinal INTEGER NOT NULL,
    PRIMARY KEY (parent_thread_id, parent_ordinal, child_thread_id)
  )`;
  yield* sql`CREATE INDEX collaboration_task_runs_child
    ON collaboration_task_runs (child_thread_id, child_through_ordinal)`;
  // Existing tasks have no recorded parent turn. Treat them as predating turn 1.
  yield* sql`INSERT INTO collaboration_task_runs
    (parent_thread_id, parent_ordinal, child_thread_id, child_through_ordinal)
    SELECT parent_thread_id, 0, child_thread_id, 1 FROM collaboration_tasks`;
});

export const makeTaskRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  return {
    lock,
    record: (parent: ThreadId, child: ThreadId, parentOrdinal: number) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO collaboration_tasks (child_thread_id, parent_thread_id)
          VALUES (${child}, ${parent}) ON CONFLICT (child_thread_id) DO NOTHING`;
        yield* sql`INSERT INTO collaboration_task_runs
          (parent_thread_id, parent_ordinal, child_thread_id, child_through_ordinal)
          VALUES (${parent}, ${parentOrdinal}, ${child}, 1)
          ON CONFLICT (parent_thread_id, parent_ordinal, child_thread_id) DO NOTHING`;
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(CollaborationError.unavailable("record_task", cause)),
        }),
      ),
    recordRun: (parent: ThreadId, parentOrdinal: number, child: ThreadId, childOrdinal: number) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT child_thread_id FROM collaboration_tasks
          WHERE child_thread_id = ${child} AND parent_thread_id = ${parent}`;
        if (rows.length === 0) return;
        yield* sql`INSERT INTO collaboration_task_runs
          (parent_thread_id, parent_ordinal, child_thread_id, child_through_ordinal)
          VALUES (${parent}, ${parentOrdinal}, ${child}, ${childOrdinal})
          ON CONFLICT (parent_thread_id, parent_ordinal, child_thread_id)
          DO UPDATE SET child_through_ordinal = MAX(child_through_ordinal, excluded.child_through_ordinal)`;
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("record_task_run", cause)),
        }),
      ),
    childrenThrough: (parent: ThreadId, parentOrdinal: number) =>
      sql<{
        readonly child_thread_id: ThreadId;
        readonly child_through_ordinal: number;
      }>`SELECT child_thread_id, MAX(child_through_ordinal) AS child_through_ordinal
        FROM collaboration_task_runs
        WHERE parent_thread_id = ${parent} AND parent_ordinal <= ${parentOrdinal}
        GROUP BY child_thread_id ORDER BY child_thread_id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            childThreadId: row.child_thread_id,
            throughOrdinal: row.child_through_ordinal,
          })),
        ),
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_task_children", cause)),
        }),
      ),
    stop: (child: ThreadId, ordinal: number) =>
      sql`UPDATE collaboration_tasks
        SET stopped_through_ordinal = MAX(stopped_through_ordinal, ${ordinal})
        WHERE child_thread_id = ${child}`.pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("record_task_stop", cause)),
        }),
      ),
    canDelegate: (parent: ThreadId, ordinal: number) =>
      sql<{ readonly stopped_through_ordinal: number }>`SELECT stopped_through_ordinal
        FROM collaboration_tasks WHERE child_thread_id = ${parent}`.pipe(
        Effect.map((rows) => rows[0] === undefined || rows[0].stopped_through_ordinal < ordinal),
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(CollaborationError.unavailable("read_task_stop", cause)),
        }),
      ),
    completion: (child: ThreadId, childOrdinal: number) =>
      Effect.gen(function* () {
        const allowed = yield* sql<{
          readonly stopped_through_ordinal: number;
        }>`SELECT stopped_through_ordinal FROM collaboration_tasks
          WHERE child_thread_id = ${child}`.pipe(
          Effect.map(
            (rows) => rows[0] === undefined || rows[0].stopped_through_ordinal < childOrdinal,
          ),
        );
        const parentRuns = yield* sql<{
          readonly parent_ordinal: number;
        }>`SELECT parent_ordinal FROM collaboration_task_runs
          WHERE child_thread_id = ${child} AND child_through_ordinal >= ${childOrdinal}
          ORDER BY child_through_ordinal, parent_ordinal LIMIT 1`;
        return {
          allowed,
          parentOrdinal: parentRuns[0]?.parent_ordinal ?? null,
        };
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(CollaborationError.unavailable("read_task_completion", cause)),
        }),
      ),
  };
});

export type TaskRecords = Effect.Success<typeof makeTaskRecords>;
