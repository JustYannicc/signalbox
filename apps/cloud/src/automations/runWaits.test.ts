// @effect-diagnostics nodeBuiltinImport:off - RunLinkStore's durable inbox needs a real SQLite query.
import { AutomationError } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Settlement } from "@signalbox/automations/engineTypes";
import * as RunLinkStore from "@signalbox/automations/runLinkStore";
import type { StepRow, WorkflowStore } from "@signalbox/automations/WorkflowStore";
import { makeRunWaits } from "@signalbox/automations/events/runWaits";

describe("run wait event delivery", () => {
  it.effect("retries a claimed event when settlement fails before the step moves", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE signalbox_automation_run_inbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          name TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          received_at TEXT NOT NULL,
          consumed_by TEXT,
          UNIQUE (run_id, event_id)
        )
      `;
      yield* sql`
        CREATE TABLE signalbox_automation_steps (
          run_id TEXT NOT NULL,
          step_key TEXT NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (run_id, step_key)
        )
      `;

      const runId = "run-1";
      const stepKey = "wait-ci";
      let status: StepRow["status"] = "waiting";
      yield* sql`
        INSERT INTO signalbox_automation_steps (run_id, step_key, status)
        VALUES (${runId}, ${stepKey}, ${status})
      `;
      const step = (): StepRow => ({
        run_id: runId,
        step_key: stepKey,
        node_id: "wait-ci",
        verb: "waitFor",
        label: "Wait for CI",
        status,
        args_json: JSON.stringify([{ on: "ci.completed" }]),
        result_json: null,
        error: null,
        error_detail_json: null,
        thread_id: null,
        wake_at: null,
        event: null,
        attempt: 1,
        started_at: "2026-10-17T00:00:00.000Z",
        finished_at: null,
      });
      const store = {
        listSteps: () => Effect.succeed([step()]),
      } as unknown as WorkflowStore;
      const links = yield* RunLinkStore.make;
      let completions = 0;
      const complete = (_runId: string, _key: string, _outcome: Settlement) =>
        Effect.gen(function* () {
          completions += 1;
          if (completions === 1)
            return yield* Effect.fail(new AutomationError({ message: "Temporary failure." }));
          yield* sql`
            UPDATE signalbox_automation_steps SET status = 'succeeded'
            WHERE run_id = ${runId} AND step_key = ${stepKey}
          `.pipe(
            Effect.mapError(
              (cause) => new AutomationError({ message: "Couldn't settle the test step.", cause }),
            ),
          );
          status = "succeeded";
          return true;
        });
      const waits = makeRunWaits({ store, links, complete });
      const envelope = { event: "ci.completed", id: "delivery-1", projectId: "project-1" };
      const listener = { runId, projectId: "project-1", patterns: ["ci.completed"] };

      const failed = yield* Effect.result(waits.deliver(envelope, [listener]));
      assert.isTrue(failed._tag === "Failure");
      assert.deepStrictEqual(
        (yield* links.unconsumed(runId)).map((event) => event.consumed_by),
        [stepKey],
      );

      yield* waits.deliver(envelope, [listener]);
      assert.strictEqual(completions, 2);
      assert.strictEqual(status, "succeeded");
      assert.deepStrictEqual(yield* links.unconsumed(runId), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
