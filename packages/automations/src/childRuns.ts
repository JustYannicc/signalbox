import { AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { Settlement } from "./engineTypes.ts";
import { fromJson } from "./json.ts";
import type { RunRow } from "./WorkflowStore.ts";

export interface ChildRunLink {
  readonly parent_run_id: string;
  readonly step_key: string;
  readonly attempt: number;
  readonly child_run_id: string;
  readonly wait: number;
  readonly parent_notified: number;
}

/** A start step keeps its child across backend retries and object eviction. */
export const makeChildRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <A>(statement: Effect.Effect<A, SqlError>) =>
    statement.pipe(
      Effect.mapError(
        (cause) => new AutomationError({ message: "Couldn't read child runs.", cause }),
      ),
    );
  return {
    get: (parentRunId: string, stepKey: string, attempt: number) =>
      query(sql<ChildRunLink>`
        SELECT * FROM signalbox_automation_children
        WHERE parent_run_id = ${parentRunId} AND step_key = ${stepKey} AND attempt = ${attempt}
      `).pipe(Effect.map((rows) => rows[0])),
    claim: (link: Omit<ChildRunLink, "parent_notified">) =>
      query(sql`
        INSERT INTO signalbox_automation_children (parent_run_id, step_key, attempt, child_run_id, wait)
        VALUES (${link.parent_run_id}, ${link.step_key}, ${link.attempt}, ${link.child_run_id}, ${link.wait})
        ON CONFLICT (parent_run_id, step_key, attempt) DO NOTHING
      `),
    parent: (childRunId: string) =>
      query(sql<ChildRunLink>`
        SELECT * FROM signalbox_automation_children WHERE child_run_id = ${childRunId}
      `).pipe(Effect.map((rows) => rows[0])),
    follow: (fromRunId: string, toRunId: string) =>
      query(sql`
        UPDATE signalbox_automation_children SET child_run_id = ${toRunId}
        WHERE child_run_id = ${fromRunId}
      `),
    notified: (link: ChildRunLink) =>
      query(sql`
        UPDATE signalbox_automation_children SET parent_notified = 1
        WHERE parent_run_id = ${link.parent_run_id} AND step_key = ${link.step_key}
          AND attempt = ${link.attempt} AND child_run_id = ${link.child_run_id}
      `),
    pending: () =>
      query(sql<ChildRunLink>`
        SELECT c.* FROM signalbox_automation_children c
        JOIN signalbox_automation_runs r ON r.run_id = c.child_run_id
        JOIN signalbox_automation_steps s ON s.run_id = c.parent_run_id AND s.step_key = c.step_key
        JOIN signalbox_automation_runs p ON p.run_id = c.parent_run_id
        WHERE c.wait = 1 AND c.parent_notified = 0 AND r.status != 'running'
          AND p.status = 'running' AND s.verb = 'start' AND s.attempt = c.attempt
      `),
    forParent: (runId: string) =>
      query(sql<ChildRunLink & { readonly automation_id: string }>`
        SELECT c.*, r.automation_id FROM signalbox_automation_children c
        JOIN signalbox_automation_runs r ON r.run_id = c.child_run_id
        WHERE c.parent_run_id = ${runId}
      `),
    prune: query(sql`
      DELETE FROM signalbox_automation_children
      WHERE parent_run_id NOT IN (SELECT run_id FROM signalbox_automation_runs)
    `),
  };
});

export type ChildRuns = Effect.Success<typeof makeChildRuns>;

export const childSettlement = (run: RunRow): Settlement | undefined => {
  if (run.status === "running") return undefined;
  if (run.status === "succeeded") return { ok: true, value: fromJson(run.output_json) };
  return {
    ok: false,
    error: `Child automation ${run.status}: ${run.error ?? "The child didn't finish."}`,
    detail: {
      why: run.error ?? "The child run was cancelled.",
      fix: "Open the child run to inspect its steps.",
      link: null,
    },
  };
};
