import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { automationError } from "./errors.ts";
import type { BuiltinToolCall } from "./builtinTools/runner.ts";
import { WorkflowEngine } from "./WorkflowEngine.ts";
import { DEFAULTS, fakeThreads, PROJECT, saveOk, withEngine } from "./WorkflowEngine.testkit.ts";

const AT = DateTime.makeUnsafe("2026-10-06T10:00:00.000Z");
let sequence = 0;

/** A thread's pull request sync, as upstream's sync reactor announces it. */
const pullRequestSynced = (
  threadId: string,
  snapshot: { state: string; checksState?: string; mergeability?: string },
) => ({
  id: `pr-sync-${++sequence}`,
  type: "thread.pull-request-synced",
  threadId,
  occurredAt: AT,
  payload: {
    id: threadId,
    projectId: PROJECT,
    title: "Fix login",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "fix-login",
    worktreePath: null,
    branchPullRequest: null,
    pullRequests: [
      {
        host: "github.com",
        repository: "acme/app",
        number: 12,
        url: "https://github.com/acme/app/pull/12",
        source: "agent",
        linkedAt: "2026-10-06T09:00:00.000Z",
        stack: null,
        snapshot: {
          title: "Fix login",
          headBranch: "fix-login",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          // Each sync is its own fact.
          syncedAt: `2026-10-06T10:00:${String(sequence).padStart(2, "0")}.000Z`,
          ...snapshot,
        },
      },
    ],
  },
});

const threadEvent = (type: string, threadId: string) => ({
  id: `thread-event-${++sequence}`,
  type,
  threadId,
  occurredAt: AT,
  payload: { id: threadId, projectId: PROJECT },
});

/** Records `signalbox.*` calls instead of running Signalbox's MCP handlers. */
const fakeTools = (answers: Record<string, unknown> = {}) => {
  const calls: BuiltinToolCall[] = [];
  return {
    calls,
    handler: {
      tools: ["list_thread_pull_requests", "t3_thread_send"],
      call: (input: BuiltinToolCall) =>
        Effect.suspend(() => {
          calls.push(input);
          return input.tool in answers
            ? Effect.succeed(answers[input.tool])
            : Effect.fail(automationError("no answer"));
        }),
    },
  };
};

const monitorsOf = (threadId: string) =>
  derivePendingBackgroundWork({
    latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
    providerThreads: [],
    turnItems: [],
    threadId,
  });

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
      const firstSync = sequence + 1;
      yield* threads.emit(pullRequestSynced("thread-9", { state: "open" }));
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
        update: `pr-sync-${firstSync}`,
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
          taskId: `automation-run:${run.id}`,
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
            message:
              "Checks failed on pull request #12 (https://github.com/acme/app/pull/12). Look at the failures and fix them.",
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
