import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskAnswerCommand } from "@t3tools/contracts/signalboxAsks";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import { blockingAsk } from "@t3tools/shared/signalboxAsks";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { ThreadObjectError } from "../thread/ThreadAccess.ts";
import { threadShellFromProjection } from "../thread/threadProjection.ts";
import { pushFor } from "../push/pushRules.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { CloudCompiler, acceptCompiled } from "./cloudCompiler.ts";

const userId = "common-ask-test-user";
const identity = {
  environmentId: EnvironmentId.make("cloud-test"),
  label: "Cloud",
  scripted: true,
};
const defaults = {
  modelSelection: scriptedModelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory
    .forUser(userId)
    .recordSignIn({ id: userId, email: "common-asks@example.test" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "common-ask-test" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  const thread = (id: string) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make(`launch-${id}`),
      threadId: ThreadId.make(id),
      projectId: Environment.SCRATCH_PROJECT_ID,
      title: id,
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(`message-${id}`), text: id, attachments: [] },
    }).pipe(Effect.andThen(cloud.settle), Effect.as(ThreadId.make(id)));
  const engine = <A, E>(use: (engine: WorkflowEngine.WorkflowEngineShape) => Effect.Effect<A, E>) =>
    cloud.inUser(userId, WorkflowEngine.WorkflowEngine.use(use));
  const save = (source: string) =>
    cloud.inUser(
      userId,
      Effect.gen(function* () {
        const result = compileForCloud(source);
        if (!result.ok) return yield* Effect.die(result.diagnostics);
        const compiler = yield* CloudCompiler;
        const workflow = yield* WorkflowEngine.WorkflowEngine;
        const compiled = yield* acceptCompiled(result.compiled);
        const saved = yield* compiler.withStaged(
          source,
          compiled,
          workflow.save({ source, projectId: Environment.SCRATCH_PROJECT_ID, defaults }),
        );
        if (!saved.ok) return yield* Effect.die(saved.diagnostics);
        return saved.automation;
      }),
    );
  const start = (
    automationId: string,
    options: {
      readonly threadId?: ThreadId;
      readonly input?: unknown;
    } = {},
  ) =>
    Effect.gen(function* () {
      const run = yield* engine((workflow) =>
        workflow.startRun({
          automationId,
          input: options.input,
          trigger: "manual",
          ...(options.threadId === undefined ? {} : { attach: { threadId: options.threadId } }),
          ...(automationId === "builtin:payment"
            ? { projectId: Environment.SCRATCH_PROJECT_ID, builtInDefaults: defaults }
            : {}),
        }),
      );
      yield* cloud.settle;
      return run.id;
    });
  const projection = (threadId: ThreadId) =>
    rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
  return { cloud, engine, projection, rpc, save, start, thread };
});

let commandNumber = 0;
const answer = (
  threadId: ThreadId,
  ask: SignalboxAsk,
  value: (typeof SignalboxAskAnswerCommand.Type.answers)[number]["value"],
): typeof SignalboxAskAnswerCommand.Type => ({
  type: "thread.ask.answer",
  commandId: CommandId.make(`common-ask-answer:${++commandNumber}`),
  threadId,
  askId: ask.id,
  round: ask.rounds.at(-1)!.number,
  answeredBy: { kind: "person", personId: userId },
  answers: [{ questionId: ask.questions[0].id, value }],
  deferredQuestionIds: [],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automation common asks on the cloud", () => {
  it.effect("reopening a task keeps its low-importance settle question quiet", () =>
    Effect.gen(function* () {
      const { cloud, engine, projection, rpc, save, start, thread } = yield* setup;
      const threadId = yield* thread("quiet-settle-question");
      const automation =
        yield* save(`export const meta = { name: "Quiet settle question" } as const;
export default workflow(async (w) => w.ask("Why did you settle this task?", {
  options: ["dropped", "done-enough"], importance: "low",
}));`);
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.settle",
        threadId,
        commandId: CommandId.make("quiet-settle-question:settle"),
      });
      const settled = yield* engine((workflow) =>
        workflow.taskLifecycle({
          threadId,
          action: "record-settle",
          reason: "done-enough",
          outcome: "The useful work is complete.",
          uncertain: true,
        }),
      );
      expect(settled.record?.condition).toBeNull();
      const runId = yield* start(automation.id, { input: { threadId } });
      const archived = threadShellFromProjection(yield* projection(threadId));
      expect(archived.archivedAt).not.toBeNull();
      expect((yield* projection(threadId)).thread.asks?.[0]?.status).toBe("archived");

      yield* engine((workflow) =>
        workflow.taskLifecycle({
          threadId,
          action: "reopen",
          expectedGeneration: settled.record!.generation,
          commandId: "quiet-settle-question:reopen",
        }),
      );
      yield* cloud.settle;
      const reopened = threadShellFromProjection(yield* projection(threadId));
      expect(reopened.archivedAt).toBeNull();
      expect(reopened.asks?.[0]?.status).toBe("pending");
      expect((yield* engine((workflow) => workflow.getRun(runId))).run.status).toBe("running");
      expect.soft(blockingAsk(reopened.asks)).toBeUndefined();
      expect(
        pushFor({
          environmentId: identity.environmentId,
          previous: archived,
          next: reopened,
          now: yield* Clock.currentTimeMillis,
        }),
      ).toBeNull();
    }),
  );

  it.effect("the Payment built-in raises a Blocker and resumes after checkout", () =>
    Effect.gen(function* () {
      const { cloud, engine, projection, start, thread } = yield* setup;
      const threadId = yield* thread("payment-common-ask");
      const runId = yield* start("builtin:payment", {
        threadId,
        input: { site: "shop.test", note: "Kettle, 12 CHF" },
      });
      const waiting = yield* engine((workflow) => workflow.getRun(runId));
      const step = waiting.steps.find((entry) => entry.verb === "ask")!;
      const ask = step.commonAsk!;
      expect(step.status).toBe("waiting");
      expect(ask).toMatchObject({
        kind: "blocker",
        status: "pending",
        source: { kind: "automation", runId, stepKey: step.key },
        questions: [
          {
            question: "Finish the payment on shop.test",
            blocking: true,
            surface: {
              kind: "kit",
              component: "automation",
              props: {
                options: ["done", "failed"],
                fields: [{ name: "note", type: "text" }],
                open: { threadId, view: "browser" },
              },
            },
          },
        ],
      });
      expect((yield* projection(threadId)).thread.asks).toContainEqual(ask);

      yield* engine((workflow) =>
        workflow.answerSignalboxAsk(
          answer(threadId, ask, { choice: "done", values: { note: "Paid by Twint" } }),
          ask,
        ),
      );
      yield* cloud.settle;
      expect(yield* engine((workflow) => workflow.getRun(runId))).toMatchObject({
        run: { status: "succeeded" },
        output: { outcome: "done", note: "Paid by Twint" },
        steps: [{ commonAsk: { kind: "blocker", status: "answered" } }],
      });
    }),
  );

  it.effect("validates fields and keeps deferred and repeated answers on one ask", () =>
    Effect.gen(function* () {
      const { cloud, engine, save, start, thread } = yield* setup;
      const threadId = yield* thread("structured-common-ask");
      const source = `export const meta = { name: "Catering" } as const;
export default workflow(async (w) => w.ask("What should we bring?", {
  options: ["tea", "cake"], multi: true,
  decisionOwner: "Catering lead", deciderIds: ["person-1", "person-2"],
  fields: { guests: { type: "number", required: true }, note: { type: "text", default: "hello" } },
}));`;
      const automation = yield* save(source);
      const runId = yield* start(automation.id, { threadId });
      const first = (yield* engine((workflow) => workflow.getRun(runId))).steps[0]!.commonAsk!;
      expect(first).toMatchObject({
        kind: "blocker",
        status: "pending",
        source: { kind: "automation", runId },
      });
      expect(first.questions[0]).toMatchObject({
        multiSelect: true,
        decisionOwner: "Catering lead",
        deciderIds: ["person-1", "person-2"],
        surface: {
          kind: "kit",
          component: "automation",
          props: {
            fields: [
              { name: "guests", required: true },
              { name: "note", default: "hello" },
            ],
          },
        },
      });

      const invalid = yield* engine((workflow) =>
        workflow
          .answerSignalboxAsk(
            answer(threadId, first, { choice: ["tea"], values: { guests: "two" } }),
            first,
          )
          .pipe(Effect.flip),
      );
      expect(invalid.message).toBe("Guests must be a number.");
      expect((yield* engine((workflow) => workflow.getRun(runId))).steps[0]!.commonAsk).toEqual(
        first,
      );

      const deferCommand: typeof SignalboxAskAnswerCommand.Type = {
        ...answer(threadId, first, null),
        answers: [],
        deferredQuestionIds: [first.questions[0].id],
        comment: "Tomorrow",
      };
      yield* engine((workflow) => workflow.answerSignalboxAsk(deferCommand, first));
      yield* engine((workflow) => workflow.answerSignalboxAsk(deferCommand, first));
      const deferred = (yield* engine((workflow) => workflow.getRun(runId))).steps[0]!.commonAsk!;
      expect(deferred.id).toBe(first.id);
      expect(deferred.rounds).toHaveLength(2);
      expect(deferred.status).toBe("pending");
      expect((yield* engine((workflow) => workflow.getRun(runId))).run.status).toBe("running");
      const stale = yield* engine((workflow) =>
        workflow.answerSignalboxAsk(answer(threadId, first, "tea"), first).pipe(Effect.flip),
      );
      expect(stale.message).toContain("round has changed");

      const finalCommand = answer(threadId, deferred, {
        choice: ["cake", "tea"],
        values: { guests: 2 },
      });
      yield* engine((workflow) => workflow.answerSignalboxAsk(finalCommand, deferred));
      yield* engine((workflow) => workflow.answerSignalboxAsk(finalCommand, deferred));
      yield* cloud.settle;
      const done = yield* engine((workflow) => workflow.getRun(runId));
      expect(done.output).toEqual({
        choice: ["tea", "cake"],
        values: { guests: 2, note: "hello" },
      });
      expect(done.steps[0]!.commonAsk).toMatchObject({
        id: first.id,
        status: "answered",
        rounds: [
          { comment: "Tomorrow" },
          {
            answers: [
              {
                answeredBy: { personId: userId },
                recommendationTaken: false,
                value: done.output,
              },
            ],
          },
        ],
      });
    }),
  );

  it.effect("withdraws cloud asks on timeout and cancellation", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = yield* Clock.currentTimeMillis;
      vi.setSystemTime(now);
      yield* TestClock.setTime(now);
      const { cloud, engine, projection, save, start, thread } = yield* setup;
      const automation = yield* save(`export const meta = { name: "Wait" } as const;
export default workflow(async (w) => w.ask("Go?", { timeout: { hours: 1 }, onTimeout: "reject" }));`);

      const timedThread = yield* thread("timeout-common-ask");
      const timedRun = yield* start(automation.id, { threadId: timedThread });
      yield* cloud.workflows.advance(3_600_000 + 1_000);
      yield* cloud.settle;
      expect(yield* engine((workflow) => workflow.getRun(timedRun))).toMatchObject({
        output: "reject",
        steps: [{ commonAsk: { status: "withdrawn" } }],
      });
      expect((yield* projection(timedThread)).thread.asks?.[0]?.status).toBe("withdrawn");

      const cancelledThread = yield* thread("cancel-common-ask");
      const cancelledRun = yield* start(automation.id, { threadId: cancelledThread });
      yield* engine((workflow) => workflow.cancelRun(cancelledRun));
      yield* cloud.settle;
      expect(yield* engine((workflow) => workflow.getRun(cancelledRun))).toMatchObject({
        run: { status: "cancelled" },
        steps: [{ commonAsk: { status: "withdrawn" } }],
      });
      expect((yield* projection(cancelledThread)).thread.asks?.[0]?.status).toBe("withdrawn");
    }),
  );

  it.effect("retries and backfills failed ask syncs through the cloud thread boundary", () =>
    Effect.gen(function* () {
      const { cloud, engine, projection, save, start, thread } = yield* setup;
      const threadId = yield* thread("retry-common-ask-sync");
      const automation = yield* save(`export const meta = { name: "Merge gate" } as const;
export default workflow(async (w) => w.ask("Merge?", { options: ["merge", "not yet"] }));`);
      let failAskSync = true;
      const originalForThread = cloud.threadDirectory.forThread.bind(cloud.threadDirectory);
      vi.spyOn(cloud.threadDirectory, "forThread").mockImplementation((id) => {
        const handle = originalForThread(id);
        if (id !== threadId) return handle;
        return {
          ...handle,
          dispatch: (actor, command, creation) => {
            if (command.type === "thread.ask.sync" && failAskSync)
              return Effect.fail(
                new ThreadObjectError({
                  operation: "dispatch",
                  cause: new Error("temporary thread ask sync failure"),
                }),
              );
            return handle.dispatch(actor, command, creation);
          },
        };
      });

      const runId = yield* start(automation.id, { threadId });
      const prior = (yield* engine((workflow) => workflow.getRun(runId))).steps[0]!.commonAsk!;
      expect(prior.status).toBe("pending");
      expect((yield* projection(threadId)).thread.asks).toBeUndefined();
      expect(yield* engine((workflow) => workflow.nextAskSyncAt)).not.toBeNull();

      // Model a persisted waiting ask whose thread projection never received it.
      const clearAskMirror = SqlClient.SqlClient.use(
        (sql) =>
          sql`UPDATE signalbox_automation_steps SET ask_json = NULL, ask_synced_at = NULL WHERE run_id = ${runId}`,
      );
      yield* cloud.inUser(userId, clearAskMirror as unknown as Effect.Effect<unknown>);
      failAskSync = false;
      yield* engine((workflow) => workflow.tick);
      const recovered = (yield* engine((workflow) => workflow.getRun(runId))).steps[0]!.commonAsk!;
      expect(recovered).toEqual(prior);
      expect((yield* projection(threadId)).thread.asks).toEqual([recovered]);
      expect(yield* engine((workflow) => workflow.nextAskSyncAt)).toBeNull();
      expect((yield* engine((workflow) => workflow.getRun(runId))).run.status).toBe("running");
    }),
  );

  it.effect("stops scheduling mirror retries when an ask refers to a missing thread", () =>
    Effect.gen(function* () {
      const { engine, save, start } = yield* setup;
      const automation = yield* save(`export const meta = { name: "Missing thread" } as const;
export default workflow(async (w) => w.ask("Still needed?", { options: ["yes", "no"] }));`);
      const runId = yield* start(automation.id, {
        input: { threadId: "thread-that-no-longer-exists" },
      });
      const detail = yield* engine((workflow) => workflow.getRun(runId));
      expect(detail.run.status).toBe("running");
      expect(detail.steps[0]?.commonAsk?.status).toBe("pending");
      expect(yield* engine((workflow) => workflow.nextAskSyncAt)).toBeNull();
    }),
  );
});
