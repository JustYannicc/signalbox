import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import type { SignalboxAsk, SignalboxAskAnswerCommand } from "@t3tools/contracts/signalboxAsks";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import {
  DEFAULTS,
  PROJECT,
  fakeHttp,
  fakeThreads,
  saveOk,
  withEngine,
  withRestartableEngine,
} from "./WorkflowEngine.testkit.ts";

const THREAD = ThreadId.make("origin-thread");
let commandNumber = 0;
const answer = (
  ask: SignalboxAsk,
  value: (typeof SignalboxAskAnswerCommand.Type.answers)[number]["value"],
): typeof SignalboxAskAnswerCommand.Type => ({
  type: "thread.ask.answer",
  commandId: CommandId.make(`answer:${++commandNumber}`),
  threadId: THREAD,
  askId: ask.id,
  round: ask.rounds.at(-1)!.number,
  answeredBy: { kind: "person", personId: "person-1" },
  answers: [{ questionId: ask.questions[0].id, value }],
  deferredQuestionIds: [],
});

const SOURCE = `export const meta = { name: "Catering" } as const;
export default workflow(async (w) => w.ask("What should we bring?", {
  options: ["tea", "cake"], multi: true,
  decisionOwner: "Catering lead", deciderIds: ["person-1", "person-2"],
  fields: { guests: { type: "number", required: true }, note: { type: "text", default: "hello" } },
}));`;

it.effect("the Payment built-in asks for unfinished checkout work as a Blocker", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads, http: fakeHttp() },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const run = yield* engine.startRun({
        automationId: "builtin:payment",
        input: { threadId: THREAD, site: "shop.test", note: "Kettle, 12 CHF" },
        attach: { threadId: THREAD },
        trigger: "manual",
        projectId: PROJECT,
        builtInDefaults: DEFAULTS,
      });
      yield* engine.drain;
      const step = (yield* engine.getRun(run.id)).steps.find((entry) => entry.verb === "ask")!;
      const ask = step.commonAsk!;
      expect(step.status).toBe("waiting");
      expect(ask).toMatchObject({
        kind: "blocker",
        status: "pending",
        source: { kind: "automation", runId: run.id, stepKey: step.key },
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
                open: { threadId: THREAD, view: "browser" },
              },
            },
          },
        ],
      });
      expect(threads.state.shells[THREAD]?.asks).toEqual([ask]);
      yield* engine.answerSignalboxAsk(
        answer(ask, { choice: "done", values: { note: "Paid by Twint" } }),
        ask,
      );
      yield* engine.drain;
      const done = yield* engine.getRun(run.id);
      expect(done).toMatchObject({
        run: { status: "succeeded" },
        output: { outcome: "done", note: "Paid by Twint" },
      });
      expect(done.steps.find((entry) => entry.key === step.key)?.commonAsk).toMatchObject({
        kind: "blocker",
        status: "answered",
      });
    }),
  );
});

it.effect("keeps one common ask through deferred rounds and validated workflow answers", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads, http: fakeHttp() },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(SOURCE);
      const run = yield* engine.startRun({
        automationId: automation.id,
        trigger: "manual",
        attach: { threadId: THREAD },
      });
      yield* engine.drain;
      const first = (yield* engine.getRun(run.id)).steps[0]!.commonAsk!;
      expect(first).toMatchObject({
        kind: "blocker",
        status: "pending",
        source: { kind: "automation", runId: run.id },
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
      expect((yield* engine.list())[0]?.waiting[0]?.commonAsk).toEqual(first);
      expect(threads.state.shells[THREAD]?.asks).toEqual([first]);

      const invalid = answer(first, { choice: ["tea"], values: { guests: "two" } });
      expect((yield* engine.answerSignalboxAsk(invalid, first).pipe(Effect.flip)).message).toBe(
        "Guests must be a number.",
      );
      expect((yield* engine.getRun(run.id)).steps[0]!.commonAsk).toEqual(first);

      const deferCommand = {
        ...answer(first, null),
        answers: [],
        deferredQuestionIds: [first.questions[0].id],
        comment: "Tomorrow",
      };
      yield* engine.answerSignalboxAsk(deferCommand, first);
      yield* engine.answerSignalboxAsk(deferCommand, first);
      const deferred = (yield* engine.getRun(run.id)).steps[0]!.commonAsk!;
      expect(deferred.rounds).toHaveLength(2);
      expect(deferred.status).toBe("pending");
      expect((yield* engine.getRun(run.id)).run.status).toBe("running");
      expect(
        (yield* engine.answerSignalboxAsk(answer(first, "tea"), first).pipe(Effect.flip)).message,
      ).toContain("round has changed");

      const finalCommand = answer(deferred, { choice: ["cake", "tea"], values: { guests: 2 } });
      yield* engine.answerSignalboxAsk(finalCommand, deferred);
      yield* engine.answerSignalboxAsk(finalCommand, deferred);
      yield* engine.drain;
      const detail = yield* engine.getRun(run.id);
      expect(detail.output).toEqual({
        choice: ["tea", "cake"],
        values: { guests: 2, note: "hello" },
      });
      expect(detail.steps[0]!.commonAsk).toMatchObject({
        id: first.id,
        status: "answered",
        rounds: [
          { comment: "Tomorrow" },
          {
            answers: [
              {
                answeredBy: { personId: "person-1" },
                recommendationTaken: false,
                value: detail.output,
              },
            ],
          },
        ],
      });
      expect(threads.state.shells[THREAD]?.asks).toEqual([detail.steps[0]!.commonAsk]);
    }),
  );
});

it.effect("withdraws the common ask on a workflow timeout or cancellation", () =>
  withEngine(
    { threads: fakeThreads(), http: fakeHttp() },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(`export const meta = { name: "Wait" } as const;
export default workflow(async (w) => w.ask("Go?", { timeout: { hours: 1 }, onTimeout: "reject" }));`);
      const timed = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      yield* TestClock.adjust("2 hours");
      yield* engine.tick;
      yield* engine.drain;
      expect(yield* engine.getRun(timed.id)).toMatchObject({
        output: "reject",
        steps: [{ commonAsk: { status: "withdrawn" } }],
      });
      const cancelled = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      yield* engine.cancelRun(cancelled.id);
      expect((yield* engine.getRun(cancelled.id)).steps[0]!.commonAsk?.status).toBe("withdrawn");
    }),
  ),
);

it.effect("retries a failed thread sync without duplicating or reopening an answered ask", () => {
  const threads = fakeThreads();
  threads.state.failAskSync = true;
  return withEngine(
    { threads, http: fakeHttp() },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(SOURCE);
      const started = yield* engine.startRun({
        automationId: automation.id,
        trigger: "manual",
        attach: { threadId: THREAD },
      });
      yield* engine.drain;
      const ask = (yield* engine.getRun(started.id)).steps[0]!.commonAsk!;
      expect(ask.status).toBe("pending");
      expect(threads.state.shells[THREAD]?.asks).toBeUndefined();
      expect(yield* engine.nextAskSyncAt).not.toBeNull();
      threads.state.failAskSync = false;
      yield* engine.tick;
      expect(threads.state.shells[THREAD]?.asks).toEqual([ask]);
      threads.state.failAskSync = true;
      const command = answer(ask, { choice: ["tea"], values: { guests: 2 } });
      yield* engine.answerSignalboxAsk(command, ask);
      yield* engine.drain;
      const answered = (yield* engine.getRun(started.id)).steps[0]!.commonAsk!;
      expect(answered.status).toBe("answered");
      expect(threads.state.shells[THREAD]?.asks).toEqual([ask]);
      threads.state.failAskSync = false;
      yield* engine.tick;
      yield* engine.answerSignalboxAsk(command, ask);
      expect(threads.state.shells[THREAD]?.asks).toEqual([answered]);
      expect(yield* engine.nextAskSyncAt).toBeNull();
    }),
  );
});

it.effect(
  "backfills an existing Merge gate ask after restart without changing its workflow",
  () => {
    const threads = fakeThreads();
    return withRestartableEngine({ threads, http: fakeHttp() }, (start) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const first = yield* start;
        const saved = yield* first.engine.save({
          source: `export const meta = { name: "Merge gate" } as const;
export default workflow(async (w) => w.ask("Merge?", { options: ["merge", "not yet"] }));`,
          projectId: PROJECT,
          defaults: DEFAULTS,
        });
        if (!saved.ok) throw new Error("Fixture failed to compile");
        const run = yield* first.engine.startRun({
          automationId: saved.automation.id,
          trigger: "manual",
          attach: { threadId: THREAD },
        });
        yield* first.engine.drain;
        const prior = (yield* first.engine.getRun(run.id)).steps[0]!.commonAsk!;
        yield* first.stop;
        yield* sql`UPDATE signalbox_automation_steps SET ask_json = NULL, ask_synced_at = NULL WHERE run_id = ${run.id}`;
        const second = yield* start;
        yield* second.engine.tick;
        yield* second.engine.drain;
        const recovered = (yield* second.engine.getRun(run.id)).steps[0]!.commonAsk!;
        expect(recovered).toEqual(prior);
        expect(recovered.kind).toBe("ready");
        expect(threads.state.shells[THREAD]?.asks).toEqual([recovered]);
        yield* second.engine.answer({
          runId: run.id,
          stepKey: recovered.source.kind === "automation" ? recovered.source.stepKey : "",
          choice: "not yet",
          answeredBy: { kind: "person", personId: "person-2" },
        });
        yield* second.engine.drain;
        expect((yield* second.engine.getRun(run.id)).steps[0]!.commonAsk).toMatchObject({
          status: "answered",
          rounds: [{ answers: [{ answeredBy: { personId: "person-2" } }] }],
        });
        yield* second.stop;
      }),
    );
  },
);

it.effect.each(["deleted", "missing"] as const)(
  "stops retrying ask sync after its thread is %s",
  (gone) => {
    const threads = fakeThreads();
    threads.state.failAskSync = true;
    return withEngine(
      { threads, http: fakeHttp() },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const automation = yield* saveOk(SOURCE);
        const run = yield* engine.startRun({
          automationId: automation.id,
          trigger: "manual",
          attach: { threadId: THREAD },
        });
        yield* engine.drain;
        expect(yield* engine.nextAskSyncAt).not.toBeNull();
        if (gone === "deleted")
          threads.state.shells[THREAD] = { deletedAt: "2026-10-17T12:00:00.000Z" };
        else threads.state.missing.add(THREAD);
        yield* engine.tick;
        expect(yield* engine.nextAskSyncAt).toBeNull();
        expect((yield* engine.getRun(run.id)).steps[0]?.commonAsk?.status).toBe("pending");
      }),
    );
  },
);
