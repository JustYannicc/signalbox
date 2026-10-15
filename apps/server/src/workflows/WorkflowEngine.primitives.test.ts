import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import {
  DEFAULTS,
  fakeThreads,
  fakeTools,
  monitorsOf,
  PROJECT,
  pullRequestSynced,
  saveOk,
  threadEvent,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

it.effect("waitFor on keeps events from the run's start and matches them like triggers", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(`export const meta = { name: "Wait for merge" } as const;
export default workflow(async (w, input: { number: number }) => {
  await w.sleep("Give it a moment", { minutes: 1 });
  const merged = await w.waitFor("Wait for the merge", { on: "pr.merged", where: { number: input.number } });
  // Kept from the run's start too: the first sync, which the merge wait didn't take.
  const update = await w.waitFor("Take the first update", { on: "pr.*", where: { event: "pr.updated" } });
  const closed = await w.waitFor("Closed after all?", { on: "pr.closed", timeout: { minutes: 5 } });
  return { merged, update: update.id, closed };
});`);
      const run = yield* engine.startRun({
        automationId: automation.id,
        input: { number: 12 },
        trigger: "manual",
      });
      yield* engine.drain;
      // Merged while the run is still sleeping: no step waits yet, so it's kept for later.
      const opened = pullRequestSynced("thread-9", { state: "open" });
      yield* threads.emit(opened);
      yield* threads.emit(pullRequestSynced("thread-9", { state: "merged" }));
      yield* engine.drain;
      yield* TestClock.adjust("2 minutes");
      yield* engine.tick;
      yield* engine.drain;
      let detail = yield* engine.getRun(run.id);
      expect(detail.steps.find((step) => step.label === "Wait for the merge")).toMatchObject({
        status: "succeeded",
        result: {
          event: "pr.merged",
          threadId: "thread-9",
          number: 12,
          state: "merged",
          repository: "acme/app",
        },
      });
      // Nothing closes it: the last wait times out with null.
      yield* TestClock.adjust("6 minutes");
      yield* engine.tick;
      yield* engine.drain;
      detail = yield* engine.getRun(run.id);
      expect(detail.run.status).toBe("succeeded");
      expect(detail.output).toMatchObject({
        merged: { event: "pr.merged" },
        update: opened.id,
        closed: null,
      });
    }),
  );
});

it.effect(
  "w.restart starts a fresh run with the new input until it settles, and stops loops",
  () => {
    const threads = fakeThreads();
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const counting = yield* saveOk(`export const meta = { name: "Count passes" } as const;
export default workflow(async (w, input: { pass: number }) => {
  await w.remember("Note the pass", "pass", input.pass);
  if (input.pass < 2) return w.restart({ pass: input.pass + 1 });
  return input.pass;
});`);
        yield* engine.startRun({
          automationId: counting.id,
          input: { pass: 0 },
          trigger: "manual",
        });
        yield* engine.drain;
        const runs = (yield* engine.get(counting.id)).runs.toReversed();
        expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
        expect(runs.every((run) => run.trigger === "manual")).toBe(true);
        expect((yield* engine.getRun(runs[0]!.id)).output).toEqual({ restartedAs: runs[1]!.id });
        expect((yield* engine.getRun(runs[2]!.id)).output).toBe(2);

        const looping = yield* saveOk(`export const meta = { name: "Loop forever" } as const;
export default workflow(async (w, input: { pass: number }) => {
  await w.remember("Note the pass", "pass", input.pass);
  return w.restart({ pass: input.pass + 1 });
});`);
        yield* engine.startRun({ automationId: looping.id, input: { pass: 0 }, trigger: "manual" });
        yield* engine.drain;
        const last = (yield* engine.get(looping.id)).runs[0]!;
        expect(last).toMatchObject({ status: "failed" });
        expect(last.error).toContain("restarted 30 times within an hour");
      }),
    );
  },
);

it.effect("trigger.at is when the run started, and a restarted run starts its own clock", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const timed = yield* saveOk(`export const meta = { name: "Restart later" } as const;
export default workflow(async (w, input: { pass: number }, trigger: { at: string }) => {
  if (input.pass > 0) return trigger.at;
  await w.remember("Note the start", "at", trigger.at);
  await w.sleep("Nap", { minutes: 1 });
  return w.restart({ pass: 1 });
});`);
      const first = yield* engine.startRun({
        automationId: timed.id,
        input: { pass: 0 },
        trigger: "manual",
      });
      yield* engine.drain;
      yield* TestClock.adjust("1 minute");
      yield* engine.tick;
      yield* engine.drain;
      const [restarted, original] = (yield* engine.get(timed.id)).runs;
      expect(original!.id).toBe(first.id);
      expect((yield* engine.getRun(original!.id)).steps[0]).toMatchObject({
        args: ["at", original!.startedAt],
      });
      expect((yield* engine.getRun(restarted!.id)).output).toBe(restarted!.startedAt);
      expect(restarted!.startedAt).not.toBe(original!.startedAt);
    }),
  ),
);

it.effect("signalbox.* calls run Signalbox's tools with the automation's access", () => {
  const threads = fakeThreads();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      const automation = yield* saveOk(`export const meta = { name: "Nudge" } as const;
export default workflow(async (w) => {
  const sent = await w.call("Wake the agent", "signalbox.t3_thread_send", { threadId: "thread-9", message: "Go", mode: "queue" });
  try {
    await w.call("Not a tool", "signalbox.preview_open", {});
  } catch (error) {
    return { sent, error: String(error) };
  }
});`);
      const run = yield* engine.startRun({ automationId: automation.id, trigger: "manual" });
      yield* engine.drain;
      const detail = yield* engine.getRun(run.id);
      expect(detail.output).toMatchObject({ sent: { delivery: "queued" } });
      expect(String((detail.output as { error: string }).error)).toContain(
        "isn't one of Signalbox's tools",
      );
      expect(tools.calls).toEqual([
        {
          tool: "t3_thread_send",
          args: { threadId: "thread-9", message: "Go", mode: "queue" },
          automationId: automation.id,
          automationName: "Nudge",
          runtimeMode: DEFAULTS.runtimeMode,
          requestKey: `${run.id}/${detail.steps[0]!.key}`,
        },
      ]);
    }),
  );
});

it.effect("the built-in PR watch runs attached to its thread and wakes the agent", () => {
  const threads = fakeThreads();
  const tools = fakeTools({ t3_thread_send: { delivery: "queued" } });
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      yield* engine.registerBuiltinTools(tools.handler);
      expect((yield* engine.builtIns).map((builtIn) => builtIn.id)).toContain(
        "builtin:watch-pull-request",
      );
      const start = engine.startRun({
        automationId: "builtin:watch-pull-request",
        input: { number: 12 },
        trigger: "manual",
        attach: { threadId: ThreadId.make("thread-9"), key: "pr:12", label: "Watching PR #12" },
        builtInDefaults: DEFAULTS,
      });
      const run = yield* start;
      yield* engine.drain;
      // The same key returns the running run instead of starting another.
      expect((yield* start).id).toBe(run.id);
      const host = (yield* engine.list()).find((automation) => automation.id === run.automationId);
      expect(host).toMatchObject({ name: "Watch pull request", builtIn: true });
      expect(monitorsOf("thread-9")).toEqual([
        {
          taskId: `automation-run:${run.automationId}:${run.id}`,
          kind: "monitor",
          description: "Wait for news on the pull request",
        },
      ]);

      yield* threads.emit(pullRequestSynced("thread-9", { state: "open", checksState: "pending" }));
      yield* threads.emit(pullRequestSynced("thread-9", { state: "open", checksState: "failing" }));
      yield* engine.drain;
      expect(tools.calls.map((call) => [call.tool, call.args])).toEqual([
        [
          "t3_thread_send",
          {
            threadId: "thread-9",
            mode: "queue",
            message: [
              "Checks failed on pull request #12 (https://github.com/acme/app/pull/12):",
              "Look at the failures and fix them.",
              "",
              "I keep watching and wake you on the next change, so end your turn when you're done. Call unwatch_pull_request when you hand the work back.",
            ].join("\n"),
          },
        ],
      ]);

      yield* threads.emit(pullRequestSynced("thread-9", { state: "merged" }));
      yield* engine.drain;
      expect(yield* engine.getRun(run.id)).toMatchObject({
        run: { status: "succeeded" },
        output: "Pull request #12: merged",
      });
      expect(monitorsOf("thread-9")).toEqual([]);

      // Editing the built-in is refused; Customize makes the project's row its own.
      const edited = yield* Effect.flip(
        engine.save({
          source: (yield* engine.get(run.automationId)).source,
          projectId: PROJECT,
          defaults: DEFAULTS,
        }),
      );
      expect(edited.message).toContain("can't be edited");
      const own = yield* engine.customize("builtin:watch-pull-request", {
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      expect(own).toMatchObject({ id: run.automationId, name: "Watch pull request" });
      expect(own.builtIn).toBeUndefined();
      const saved = yield* engine.save({
        source: (yield* engine.get(own.id)).source.replace("30 }", "10 }"),
        projectId: PROJECT,
        defaults: DEFAULTS,
      });
      expect(saved.ok && saved.automation.id).toBe(own.id);
      const again = yield* engine.startRun({
        automationId: "builtin:watch-pull-request",
        input: { number: 13, threadId: "thread-9" },
        trigger: "manual",
        projectId: PROJECT,
        builtInDefaults: DEFAULTS,
      });
      // The customized automation runs; no new host row appears.
      expect(again.automationId).toBe(own.id);
      expect((yield* engine.list()).filter((row) => row.builtIn)).toEqual([]);
    }),
  );
});

it.effect("settling or stopping a thread cancels the runs attached to it", () => {
  const threads = fakeThreads();
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(`export const meta = { name: "Babysit" } as const;
export default workflow(async (w) => {
  await w.sleep("Wait a day", { days: 1 });
});`);
      const attach = (threadId: string) =>
        engine.startRun({
          automationId: automation.id,
          trigger: "manual",
          attach: { threadId: ThreadId.make(threadId) },
        });
      const settled = yield* attach("thread-1");
      const stopped = yield* attach("thread-2");
      yield* engine.drain;
      expect(monitorsOf("thread-1")).toMatchObject([{ description: "Wait a day" }]);

      yield* threads.emit(threadEvent("thread.settled", "thread-1"));
      yield* engine.drain;
      expect((yield* engine.getRun(settled.id)).run.status).toBe("cancelled");
      expect(monitorsOf("thread-1")).toEqual([]);

      expect(yield* engine.cancelAttached("thread-2")).toBe(1);
      expect((yield* engine.getRun(stopped.id)).run.status).toBe("cancelled");
      expect(yield* engine.cancelAttached("thread-2")).toBe(0);
    }),
  );
});
