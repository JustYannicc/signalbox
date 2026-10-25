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
  it.effect(
    "delivers only events after a run cursor, even when old and new events share a timestamp",
    () =>
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

        const links = yield* RunLinkStore.make;
        const runIds = ["run-failure", "run-conflict", "run-merge", "run-close"];
        const events = ["pr.checks.failed", "pr.conflicted", "pr.merged", "pr.closed"];
        const outcomes: Array<{ runId: string; event: string }> = [];
        const rows = new Map<string, StepRow>();
        for (const [index, runId] of runIds.entries()) {
          assert.strictEqual((yield* links.captureEventCursor(runId)).sequence, 0);
          for (let stale = 0; stale < 8; stale++) {
            const envelope = {
              event: "pr.conflicted",
              id: `${runId}:stale-${stale}`,
              at: "2026-10-17T20:16:20.000Z",
              projectId: "project-1",
              headSha: null,
            };
            yield* links.keepEvent({
              run_id: runId,
              event_id: envelope.id,
              name: envelope.event,
              envelope_json: JSON.stringify(envelope),
              received_at: "2026-10-17T20:16:20.000Z",
            });
          }
          const cursor = yield* links.captureEventCursor(runId);
          const stepKey = `${runId}:wait`;
          rows.set(runId, {
            run_id: runId,
            step_key: stepKey,
            node_id: stepKey,
            verb: "waitFor",
            label: "Wait for the pull request",
            status: "waiting",
            args_json: JSON.stringify([
              { on: events, where: { projectId: "project-1" }, after: cursor },
            ]),
            result_json: null,
            error: null,
            error_detail_json: null,
            thread_id: null,
            wake_at: null,
            event: null,
            attempt: 1,
            started_at: "2026-10-17T20:16:20.000Z",
            finished_at: null,
          });
          yield* sql`
          INSERT INTO signalbox_automation_steps (run_id, step_key, status)
          VALUES (${runId}, ${stepKey}, 'waiting')
        `;

          const fresh = {
            event: events[index]!,
            id: `${runId}:fresh`,
            at: "2026-10-17T20:16:20.000Z",
            projectId: "project-1",
            headSha: null,
          };
          const store = {
            listSteps: (id: string) => Effect.succeed([rows.get(id)!]),
          } as unknown as WorkflowStore;
          const waits = makeRunWaits({
            store,
            links,
            complete: (id, key, outcome) =>
              Effect.gen(function* () {
                if (outcome.ok)
                  outcomes.push({
                    runId,
                    event: String((outcome.value as { event: unknown }).event),
                  });
                yield* sql`
                UPDATE signalbox_automation_steps SET status = 'succeeded'
                WHERE run_id = ${id} AND step_key = ${key}
              `.pipe(
                  Effect.mapError(
                    (cause) =>
                      new AutomationError({ message: "Couldn't settle the test step.", cause }),
                  ),
                );
                const current = rows.get(id)!;
                rows.set(id, { ...current, status: "succeeded" });
                return true;
              }),
          });
          yield* waits.deliver(fresh, [{ runId, projectId: "project-1", patterns: events }]);
        }

        assert.deepStrictEqual(
          outcomes,
          runIds.map((runId, index) => ({ runId, event: events[index] })),
        );
        for (const runId of runIds) {
          assert.deepStrictEqual(
            (yield* links.unconsumed(runId)).map((event) => event.name),
            Array.from({ length: 8 }, () => "pr.conflicted"),
          );
        }
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

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
