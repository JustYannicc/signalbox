import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as CloudAutomations from "../automations/CloudAutomations.ts";

export interface RetainedAutomationRun {
  readonly id: string;
  readonly reason: string;
}

export interface PrepareAutomationTrashResult {
  /** False only while an owned run still needs cancellation. Retained shared runs don't block trash. */
  readonly ready: boolean;
  readonly retained: ReadonlyArray<RetainedAutomationRun>;
}

interface RunRow {
  readonly run_id: string;
  readonly status: string;
  readonly external_thread_id: string | null;
}

interface RunEdge {
  readonly source_id: string;
  readonly target_id: string;
}

interface Ownership {
  readonly rows: ReadonlyArray<RunRow>;
  /** An edge points from a run to the parent that started, retried, or restarted it. */
  readonly edges: ReadonlyArray<RunEdge>;
  readonly safeIds: ReadonlySet<string>;
}

const failed = (message: string) => new SignalboxTrashError({ message });
const encodeThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engineOption = yield* Effect.serviceOption(WorkflowEngine.WorkflowEngine);
  const automationsOption = yield* Effect.serviceOption(CloudAutomations.CloudAutomations);

  const ownership = (threadIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const encodedThreads = encodeThreadIds([...new Set(threadIds)]);
      const rows = yield* sql<RunRow>`
        WITH RECURSIVE trash_threads(thread_id) AS (
          SELECT value FROM json_each(${encodedThreads})
        ),
        edges(source_id, target_id) AS (
          SELECT run_id, parent_run_id FROM signalbox_automation_runs
            WHERE parent_run_id IS NOT NULL
          UNION ALL
          SELECT run_id, retry_of_run_id FROM signalbox_automation_runs
            WHERE retry_of_run_id IS NOT NULL
          UNION ALL
          SELECT run_id, restart_of_run_id FROM signalbox_automation_run_links
            WHERE restart_of_run_id IS NOT NULL
        ),
        seeds(run_id) AS (
          SELECT DISTINCT r.run_id FROM signalbox_automation_runs r
          WHERE EXISTS (
            SELECT 1 FROM signalbox_automation_run_links l
            JOIN trash_threads t ON t.thread_id = l.thread_id
            WHERE l.run_id = r.run_id
          ) OR EXISTS (
            SELECT 1 FROM signalbox_automation_steps s
            JOIN trash_threads t ON t.thread_id = s.thread_id
            WHERE s.run_id = r.run_id
          )
        ),
        owned(run_id) AS (
          SELECT run_id FROM seeds
          UNION
          SELECT e.source_id FROM edges e JOIN owned parent ON e.target_id = parent.run_id
        )
        SELECT
          r.run_id,
          r.status,
          COALESCE(
            (SELECT s.thread_id FROM signalbox_automation_steps s
              WHERE s.run_id = r.run_id AND s.thread_id IS NOT NULL
                AND s.thread_id NOT IN (SELECT thread_id FROM trash_threads)
              LIMIT 1),
            (SELECT l.thread_id FROM signalbox_automation_run_links l
              WHERE l.run_id = r.run_id AND l.thread_id IS NOT NULL
                AND l.thread_id NOT IN (SELECT thread_id FROM trash_threads)
              LIMIT 1)
          ) AS external_thread_id
        FROM owned o JOIN signalbox_automation_runs r ON r.run_id = o.run_id
      `;
      if (rows.length === 0)
        return { rows, edges: [], safeIds: new Set<string>() } satisfies Ownership;

      const ids = rows.map((row) => row.run_id);
      const edges = yield* sql<RunEdge>`
        SELECT run_id AS source_id, parent_run_id AS target_id
          FROM signalbox_automation_runs WHERE parent_run_id IN ${sql.in(ids)}
        UNION
        SELECT run_id AS source_id, retry_of_run_id AS target_id
          FROM signalbox_automation_runs WHERE retry_of_run_id IN ${sql.in(ids)}
        UNION
        SELECT l.run_id AS source_id, l.restart_of_run_id AS target_id
          FROM signalbox_automation_run_links l
          JOIN signalbox_automation_runs r ON r.run_id = l.run_id
          WHERE l.restart_of_run_id IN ${sql.in(ids)}
      `;

      // Remove shared runs, then any run another retained run still points to.
      const safeIds = new Set(
        rows.filter((row) => row.external_thread_id === null).map((row) => row.run_id),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of edges) {
          if (safeIds.has(edge.target_id) && !safeIds.has(edge.source_id)) {
            safeIds.delete(edge.target_id);
            changed = true;
          }
        }
      }
      return { rows, edges, safeIds } satisfies Ownership;
    });

  const retainedOf = (result: Ownership): ReadonlyArray<RetainedAutomationRun> =>
    result.rows.flatMap((row) => {
      if (result.safeIds.has(row.run_id)) return [];
      if (row.external_thread_id !== null) {
        return [
          {
            id: row.run_id,
            reason: `It references surviving thread ${row.external_thread_id}.`,
          },
        ];
      }
      const dependency = result.edges.find(
        (edge) => edge.target_id === row.run_id && !result.safeIds.has(edge.source_id),
      );
      return [
        {
          id: row.run_id,
          reason: dependency
            ? `Retained run ${dependency.source_id} still references it.`
            : "It belongs to a run family that must be retained.",
        },
      ];
    });

  const cancel = (runId: string) => {
    if (Option.isNone(engineOption)) {
      return Effect.fail(
        failed("The automation engine is unavailable; its active runs are still safe."),
      );
    }
    return engineOption.value.cancelRun(runId).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not stop an automation run during Trash preparation", {
          runId,
          cause,
        }).pipe(
          Effect.andThen(
            sql<{
              readonly status: string;
            }>`SELECT status FROM signalbox_automation_runs WHERE run_id = ${runId}`,
          ),
          Effect.flatMap((rows) =>
            rows.length === 0 || rows[0]!.status !== "running"
              ? Effect.void
              : Effect.fail(failed("Could not stop an automation run before trashing its thread.")),
          ),
        ),
      ),
    );
  };

  const prepareAutomationTrash = (threadIds: ReadonlyArray<string>, _trashId: string) =>
    Effect.gen(function* () {
      const before = yield* ownership(threadIds);
      const active = before.rows.filter(
        (row) => before.safeIds.has(row.run_id) && row.status === "running",
      );
      if (active.length > 0) {
        if (Option.isNone(automationsOption)) {
          return yield* failed("The automation engine cannot drain run cancellation yet.");
        }
        for (const row of active) yield* cancel(row.run_id);
        yield* automationsOption.value.flush;
      }
      const after = yield* ownership(threadIds);
      const notStopped = after.rows.filter(
        (row) => after.safeIds.has(row.run_id) && row.status === "running",
      );
      const retained = [
        ...retainedOf(after),
        ...notStopped.map((row) => ({
          id: row.run_id,
          reason: "The owned run is still active and will be retried before thread cleanup.",
        })),
      ];
      return { ready: notStopped.length === 0, retained } satisfies PrepareAutomationTrashResult;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(SignalboxTrashError)(cause)
          ? cause
          : failed("Could not prepare automation runs for Trash."),
      ),
    );

  return { prepareAutomationTrash };
});

export class TrashAutomations extends Context.Service<
  TrashAutomations,
  Effect.Success<typeof make>
>()("@signalbox/cloud/trash/trashAutomations") {}

export const layer = Layer.effect(TrashAutomations, make);
