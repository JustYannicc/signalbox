import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OrchestrationV2Subagent } from "@t3tools/contracts";

import { ThreadStore } from "./ThreadStore.ts";
import { coordinatorId, siblingId, scriptPath, workflowFixture } from "./workflowTestKit.ts";
import {
  freshDatabase,
  withObject,
  launch,
  owner,
  threadId,
  hello,
  turnReport,
  liveTurn,
} from "./runnerTesting.ts";

const encodeSubagent = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2Subagent));
const stop = { threadId, subagentId: coordinatorId };
const get = { ...stop, scriptPath };
const running = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const plan = yield* runner.reconcile;
    if (plan.ensure === null) throw new Error("No machine");
    const generation = plan.ensure.generation;
    yield* runner.hello({ ...hello(generation, plan.ensure.token), workflowStops: true });
    const turn = yield* liveTurn(runner);
    yield* runner.batch({
      generation,
      sequence: 1,
      items: [turnReport(turn.runId, turn.runOrdinal, turn.providerThread).started],
    });
    const fixture = yield* engine.apply((projection, ctx) => {
      const data = workflowFixture(projection!, ctx);
      return Effect.succeed({ events: data.events, scripts: data.scripts, result: data });
    });
    yield* engine.stopWorkflow(owner, stop);
    const request = (yield* runner.work).workflowStops[0]!;
    return { generation, fixture, request };
  });

describe("workflow stop recovery", () => {
  it.effect(
    "records a failed provider stop without cancelling any work or endlessly requeueing it",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { generation, request } = yield* running(engine, runner);
          const before = yield* engine.snapshot(owner);
          yield* runner.batch({
            generation,
            sequence: 2,
            items: [{ kind: "workflow.stopped", ...request, ok: false }],
          });
          const failed = yield* engine.snapshot(owner);
          expect(
            failed.projection.subagents.find((task) => task.id === coordinatorId),
          ).toMatchObject({ status: "running", workflow: { stop: { status: "failed" } } });
          expect(failed.projection.runs).toEqual(before.projection.runs);
          expect(failed.projection.subagents.find((task) => task.id === siblingId)).toEqual(
            before.projection.subagents.find((task) => task.id === siblingId),
          );
          expect((yield* runner.work).workflowStops).toEqual([]);
          yield* engine.stopWorkflow(owner, stop);
          const retried = yield* engine.snapshot(owner);
          const retry = (yield* runner.work).workflowStops[0]!;
          expect(retry.attempt).toBe(2);
          yield* engine.stopWorkflow(owner, stop);
          expect(yield* engine.snapshot(owner)).toEqual(retried);
          yield* runner.batch({
            generation,
            sequence: 3,
            items: [{ kind: "workflow.stopped", ...request, ok: false }],
          });
          expect(yield* engine.snapshot(owner)).toEqual(retried);
          yield* runner.batch({
            generation,
            sequence: 4,
            items: [{ kind: "workflow.stopped", ...retry, ok: true }],
          });
          expect(
            (yield* engine.snapshot(owner)).projection.subagents.find(
              (task) => task.id === coordinatorId,
            )?.status,
          ).toBe("cancelled");
        }),
      ),
  );

  it.effect("finishes a pending stop durably when its machine lease is gone", () => {
    const file = freshDatabase();
    return Effect.gen(function* () {
      yield* withObject(file, (engine, runner, context) =>
        Effect.gen(function* () {
          yield* running(engine, runner);
          const store = Context.get(context, ThreadStore);
          const lease = yield* store.machine;
          yield* store.saveMachine({
            ...lease,
            generation: lease.generation + 1,
            status: "none",
            token: null,
          });
          expect((yield* runner.work).workflowStops).toEqual([]);
          expect(
            (yield* engine.snapshot(owner)).projection.subagents.find(
              (task) => task.id === coordinatorId,
            )?.status,
          ).toBe("cancelled");
        }),
      );
      yield* withObject(file, (engine) =>
        Effect.gen(function* () {
          expect((yield* engine.getWorkflowScript(owner, get)).contents).toContain(
            "exact workflow-one",
          );
          expect(
            (yield* engine.snapshot(owner)).projection.subagents.find(
              (task) => task.id === coordinatorId,
            )?.workflow?.stop?.status,
          ).toBe("stopped");
          yield* engine.stopWorkflow(owner, stop);
        }),
      );
    });
  });

  it.effect("preserves the attached revision and cloud stop request across provider updates", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { generation, fixture, request } = yield* running(engine, runner);
        const task = fixture.tasks[0]!;
        const update = {
          ...task,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          workflow: {
            ...task.workflow!,
            runHandles: { scriptPath: "/workflows/reused.js", scriptRevision: "different" },
            stop: { ...request, status: "stopped" as const },
          },
        };
        yield* runner.batch({
          generation,
          sequence: 2,
          items: [
            {
              kind: "provider",
              runId: request.runId,
              event: {
                type: "subagent.updated",
                driver: task.driver,
                subagent: encodeSubagent(update),
              },
            },
          ],
        });
        const projection = (yield* engine.snapshot(owner)).projection;
        expect(projection.subagents.find((each) => each.id === task.id)).toMatchObject({
          providerInstanceId: fixture.tasks[0]!.providerInstanceId,
          workflow: {
            stop: { status: "requested" },
            runHandles: { scriptPath, scriptRevision: "revision:workflow-one" },
          },
        });
        expect((yield* engine.getWorkflowScript(owner, get)).contents).toContain(
          "exact workflow-one",
        );
      }),
    ),
  );
});
