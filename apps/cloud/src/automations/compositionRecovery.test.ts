import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { COMPOSITION_TEST_USER, makeCompositionHarness, source } from "./compositionHarness.ts";

afterEach(() => vi.useRealTimers());

describe("composed automation recovery", () => {
  it.effect("keeps the old child and its link when inserting a restart continuation fails", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const harness = yield* makeCompositionHarness();
      const child = yield* harness.save(
        source(
          "Restart after hold",
          `await w.sleep("Hold before restart", { seconds: 2 });
           if (input.pass === 0) return w.restart({ pass: 1 });
           return input.pass;`,
        ),
      );
      const parent = yield* harness.save(
        source(
          "Parent waiting through restart",
          `return await w.start("Restart after hold", { pass: 0 });`,
        ),
      );
      const parentRun = yield* harness.start(parent.id);
      yield* harness.cloud.workflows.idle;
      const before = yield* harness.getRun(parentRun.id);
      const linksBefore = yield* harness.childLinks(parentRun.id);
      const childRunId = linksBefore[0]?.child_run_id;
      if (!childRunId) return yield* Effect.die("The parent didn't record its child.");

      yield* harness.cloud.inUser(
        COMPOSITION_TEST_USER,
        SqlClient.SqlClient.use(
          (sql) => sql`
            CREATE TRIGGER reject_restart_continuation
            BEFORE INSERT ON signalbox_automation_runs
            WHEN NEW.input_json = '{"pass":1}'
            BEGIN SELECT RAISE(ABORT, 'simulated continuation insert failure'); END
          `,
        ).pipe(Effect.provide(harness.cloud.userObject(COMPOSITION_TEST_USER))),
      );
      yield* harness.cloud.workflows.advance(2_000);

      const oldChild = yield* harness.getRun(childRunId);
      const after = yield* harness.getRun(parentRun.id);
      const linksAfter = yield* harness.childLinks(parentRun.id);
      const childRuns = yield* harness.cloud.inUser(
        COMPOSITION_TEST_USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{ readonly run_id: string }>`
              SELECT run_id FROM signalbox_automation_runs
              WHERE automation_id = ${child.id}
            `,
        ).pipe(Effect.provide(harness.cloud.userObject(COMPOSITION_TEST_USER))),
      );

      expect(before.run.status).toBe("running");
      expect(oldChild.run.status).toBe("running");
      expect(after.run.status).toBe("running");
      expect(after.steps[0]?.status).toBe("waiting");
      expect(linksAfter).toEqual(linksBefore);
      expect(childRuns.map((run) => run.run_id)).toEqual([childRunId]);
    }),
  );

  it.effect("replays a terminal child result whose waiting parent missed its wake, only once", () =>
    Effect.gen(function* () {
      const harness = yield* makeCompositionHarness();
      yield* harness.save(
        source(
          "Long child",
          `await w.sleep("Keep the child open", { days: 1 });
           return "child result";`,
        ),
      );
      const parent = yield* harness.save(
        source(
          "Recover child wake",
          `const result = await w.start("Long child", null);
           await w.sleep("Keep the parent open", { days: 1 });
           return result;`,
        ),
      );
      const parentRun = yield* harness.start(parent.id);
      yield* harness.cloud.workflows.idle;
      const waiting = yield* harness.getRun(parentRun.id);
      const links = yield* harness.childLinks(parentRun.id);
      const childRunId = links[0]?.child_run_id;
      const stepKey = waiting.steps.find((step) => step.verb === "start")?.key;
      if (!childRunId || !stepKey)
        return yield* Effect.die("The parent didn't record its waiting child step.");

      // This is the committed gap: the child is terminal and the parent's
      // current start attempt is terminal, but the workflow instance missed its wake.
      yield* harness.cloud.inUser(
        COMPOSITION_TEST_USER,
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`
              UPDATE signalbox_automation_runs
              SET status = 'succeeded', output_json = ${JSON.stringify("recovered")},
                  finished_at = '2026-10-18T00:00:00.000Z'
              WHERE run_id = ${childRunId}
            `;
            yield* sql`
              UPDATE signalbox_automation_steps
              SET status = 'succeeded', result_json = ${JSON.stringify("recovered")},
                  finished_at = '2026-10-18T00:00:00.000Z'
              WHERE run_id = ${parentRun.id} AND step_key = ${stepKey} AND attempt = 1
            `;
          }),
        ).pipe(Effect.provide(harness.cloud.userObject(COMPOSITION_TEST_USER))),
      );

      const deliveriesBefore = harness.cloud.workflows.eventDeliveries(parentRun.id);
      yield* harness.cloud.inUser(
        COMPOSITION_TEST_USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.tick),
      );
      yield* harness.cloud.workflows.idle;

      const resumed = yield* harness.getRun(parentRun.id);
      const deliveriesAfterFirstTick = harness.cloud.workflows.eventDeliveries(parentRun.id);

      expect(waiting.steps[0]?.status).toBe("waiting");
      expect(resumed.run.status).toBe("running");
      expect(deliveriesAfterFirstTick - deliveriesBefore).toBe(1);
      expect(resumed.steps.map((step) => [step.verb, step.status])).toEqual([
        ["start", "succeeded"],
        ["sleep", "waiting"],
      ]);

      const notified = yield* harness.cloud.inUser(
        COMPOSITION_TEST_USER,
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{ readonly parent_notified: number }>`
              SELECT parent_notified FROM signalbox_automation_children
              WHERE parent_run_id = ${parentRun.id}
            `,
        ).pipe(Effect.provide(harness.cloud.userObject(COMPOSITION_TEST_USER))),
      );
      expect(notified[0]?.parent_notified).toBe(1);

      yield* harness.cloud.inUser(
        COMPOSITION_TEST_USER,
        WorkflowEngine.WorkflowEngine.use((engine) => engine.tick),
      );
      yield* harness.cloud.workflows.idle;

      expect(harness.cloud.workflows.eventDeliveries(parentRun.id)).toBe(deliveriesAfterFirstTick);
    }),
  );
});
