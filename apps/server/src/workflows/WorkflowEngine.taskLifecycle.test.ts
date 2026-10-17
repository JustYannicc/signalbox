import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import {
  DEFAULTS,
  fakeThreads,
  fakeTools,
  saveOk,
  threadEvent,
  withEngine,
} from "./WorkflowEngine.testkit.ts";

const waitAutomation = `export const meta = { name: "Wait for task completion" } as const;
export default workflow(async (w) => {
  await w.sleep("Wait for the task's condition", { days: 1 });
});`;

const messageEvent = (id: string, role: "user" | "assistant", streaming = false) => ({
  id: `event-${id}`,
  type: "message.updated",
  threadId: "thread-9",
  occurredAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
  payload: { id, threadId: "thread-9", role, streaming },
});

it.effect("adopts an event-started done-condition run as the thread attachment", () => {
  const threads = fakeThreads();
  const now = DateTime.makeUnsafe("2026-10-17T09:00:00Z");
  threads.state.shells["thread-9"] = {
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    updatedAt: now,
  };
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(waitAutomation);
      const run = yield* engine.startRun({
        automationId: automation.id,
        input: { threadId: "thread-9" },
        trigger: "event",
      });
      const proposed = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "propose",
        automationId: automation.id,
        summary: "The requested date passed",
        runId: run.id,
        input: { type: "date", at: "2026-10-18T00:00:00.000Z" },
      });
      expect(proposed.record?.condition?.runId).toBe(run.id);
      expect(yield* engine.cancelAttached("thread-9")).toBe(1);
      expect((yield* engine.getRun(run.id)).run.status).toBe("cancelled");
    }),
  );
});

it.effect("reopens a settled task and rearms its preserved condition at a new generation", () => {
  const threads = fakeThreads();
  const now = DateTime.makeUnsafe("2026-10-17T09:00:00Z");
  threads.state.shells["thread-9"] = {
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    updatedAt: now,
  };
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(waitAutomation);
      const proposed = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "propose",
        automationId: automation.id,
        summary: "The requested date passed",
        input: { type: "date", at: "2026-10-18T00:00:00.000Z" },
      });
      const priorRunId = proposed.record?.condition?.runId;
      if (!priorRunId)
        throw new Error(
          `No evaluator was bound for ${String(proposed.record?.condition?.automationId)} at generation ${String(proposed.record?.generation)}.`,
        );

      threads.state.shells["thread-9"] = {
        ...threads.state.shells["thread-9"],
        archivedAt: now,
        settledAt: now,
        settledOverride: "settled",
      };
      const settled = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "record-settle",
        reason: "done-enough",
        outcome: "Useful work is done",
        expectedGeneration: proposed.record!.generation,
      });
      expect(settled.applied).toBe(true);
      expect((yield* engine.getRun(priorRunId!)).run.status).toBe("cancelled");

      const reopenCommand = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "reopen",
        expectedGeneration: settled.record!.generation,
      });
      expect(reopenCommand.applied).toBe(true);
      expect(reopenCommand.record?.generation).toBe((settled.record?.generation ?? 0) + 1);

      threads.state.shells["thread-9"] = {
        ...threads.state.shells["thread-9"],
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
        updatedAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
      };
      const reopenedEvent = threadEvent("thread.unsettled", "thread-9");
      yield* threads.emit({
        ...reopenedEvent,
        payload: {
          ...reopenedEvent.payload,
          updatedAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
        },
      });

      const reopened = yield* engine.taskLifecycle({ threadId: "thread-9", action: "read" });
      const nextRunId = reopened.record?.condition?.runId;
      expect(reopened.record).toMatchObject({
        generation: proposed.record!.generation + 3,
        outcome: null,
        settledAt: null,
        condition: { summary: "The requested date passed" },
      });
      if (!nextRunId) throw new Error("The reopened task has no evaluator run.");
      expect(nextRunId).not.toBe(priorRunId);
      expect((yield* engine.getRun(nextRunId!)).run.status).toBe("running");
    }),
  );
});

it.effect("rearms after a stale completion loses to a newer message", () => {
  const threads = fakeThreads();
  const before = DateTime.makeUnsafe("2026-10-17T09:00:00Z");
  threads.state.shells["thread-9"] = {
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    updatedAt: before,
  };
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(waitAutomation);
      const proposed = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "propose",
        automationId: automation.id,
        summary: "The requested date passed",
        input: { type: "date", at: "2026-10-18T00:00:00.000Z" },
      });
      const priorRunId = proposed.record?.condition?.runId;
      if (!priorRunId)
        throw new Error(
          `No evaluator was bound for ${String(proposed.record?.condition?.automationId)} at generation ${String(proposed.record?.generation)}.`,
        );
      const generation = proposed.record!.generation;

      threads.state.shells["thread-9"] = {
        ...threads.state.shells["thread-9"],
        updatedAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
      };
      const stale = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "complete",
        outcome: "Stale task result",
        expectedGeneration: generation,
        expectedUpdatedAt: DateTime.formatIso(before),
      });
      expect(stale.applied).toBe(false);
      expect(stale.thread.archivedAt).toBeNull();
      expect(stale.record?.generation).toBe(generation);
      const nextRunId = stale.record?.condition?.runId;
      if (!nextRunId) throw new Error("The newer message has no replacement evaluator run.");
      expect(nextRunId).not.toBe(priorRunId);
      expect((yield* engine.getRun(priorRunId!)).run.status).toBe("cancelled");
      expect((yield* engine.getRun(nextRunId!)).run.status).toBe("running");
    }),
  );
});

it.effect("rearms for a non-streaming user message, but not assistant messages", () => {
  const threads = fakeThreads();
  const before = DateTime.makeUnsafe("2026-10-17T09:00:00Z");
  threads.state.shells["thread-9"] = {
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    updatedAt: before,
  };
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(waitAutomation);
      const proposed = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "propose",
        automationId: automation.id,
        summary: "The requested date passed",
        input: { type: "date", at: "2026-10-18T00:00:00.000Z" },
      });
      const priorRunId = proposed.record?.condition?.runId;
      if (!priorRunId) throw new Error("The done-condition has no evaluator run.");
      const generation = proposed.record!.generation;

      yield* threads.emit(messageEvent("assistant-1", "assistant"));
      yield* threads.emit(messageEvent("streaming-user-1", "user", true));
      const unchanged = yield* engine.taskLifecycle({ threadId: "thread-9", action: "read" });
      expect(unchanged.record?.generation).toBe(generation);
      expect(unchanged.record?.condition?.runId).toBe(priorRunId);
      expect((yield* engine.getRun(priorRunId)).run.status).toBe("running");

      threads.state.shells["thread-9"] = {
        ...threads.state.shells["thread-9"],
        updatedAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
      };
      yield* threads.emit(messageEvent("user-1", "user"));

      const reopened = yield* engine.taskLifecycle({ threadId: "thread-9", action: "read" });
      const nextRunId = reopened.record?.condition?.runId;
      expect(reopened.record?.generation).toBe(generation + 1);
      if (!nextRunId) throw new Error("The new user message has no replacement evaluator run.");
      expect(nextRunId).not.toBe(priorRunId);
      expect((yield* engine.getRun(priorRunId)).run.status).toBe("cancelled");
      expect((yield* engine.getRun(nextRunId)).run.status).toBe("running");
      expect((yield* engine.getRun(nextRunId)).input).toMatchObject({
        expectedGeneration: generation + 1,
      });
    }),
  );
});

it.effect(
  "only published automations can change task lifecycle; agents can read in-project",
  () => {
    const threads = fakeThreads();
    threads.state.shells["thread-9"] = {
      archivedAt: null,
      deletedAt: null,
      settledAt: null,
      settledOverride: null,
      creationSource: "web",
      id: "thread-9",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      lineage: {
        rootThreadId: "thread-9",
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: DateTime.makeUnsafe("2026-10-17T09:00:00Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-17T09:00:00Z"),
    };
    threads.state.threadRuns["thread-9"] = [];
    const tools = fakeTools();
    const source = (name: string, threadId: string, action: "read" | "reopen") =>
      `export const meta = { name: "${name}" } as const;
export default workflow(async (w) => {
  return await w.call("Change task", "signalbox.task_lifecycle", { threadId: "${threadId}", action: "${action}" });
});`;
    return withEngine(
      { threads },
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        yield* engine.registerBuiltinTools(tools.handler);
        const run = (automationId: string) =>
          Effect.gen(function* () {
            const started = yield* engine.startRun({ automationId, trigger: "manual" });
            yield* engine.drain;
            return yield* engine.getRun(started.id);
          });

        const agentVersion = yield* saveOk(source("Change task as agent", "thread-9", "reopen"));
        const refused = yield* run(agentVersion.id);
        expect(refused.run.status).toBe("failed");
        expect(refused.run.error).toContain(
          "Only Signalbox's own automations, or one a person published, can change a task's lifecycle",
        );
        expect(refused.run.error).not.toContain("merge gate");
        expect(tools.calls).toEqual([]);
        expect((yield* engine.taskLifecycle({ threadId: "thread-9", action: "read" })).record).toBe(
          null,
        );

        const draft = yield* engine.save({
          source: source("Change task as a person", "thread-9", "reopen"),
          projectId: "project-automations" as never,
          defaults: DEFAULTS,
          draft: true,
        });
        if (!draft.ok) throw new Error("draft didn't save");
        yield* engine.publish(draft.automation.id, { version: draft.automation.draftVersion! });
        const publishedRun = yield* run(draft.automation.id);
        if (publishedRun.run.status !== "succeeded")
          throw new Error(`Published lifecycle mutation failed: ${String(publishedRun.run.error)}`);
        expect(
          (yield* engine.taskLifecycle({ threadId: "thread-9", action: "read" })).record,
        ).toMatchObject({ generation: 1 });

        const reader = yield* saveOk(source("Read task", "thread-9", "read"));
        expect((yield* run(reader.id)).run.status).toBe("succeeded");

        threads.state.shells["thread-elsewhere"] = {
          projectId: "project-other",
          archivedAt: null,
          deletedAt: null,
          settledAt: null,
          settledOverride: null,
        };
        const outOfScopeReader = yield* saveOk(
          source("Read another project's task", "thread-elsewhere", "read"),
        );
        const outOfScope = yield* run(outOfScopeReader.id);
        expect(outOfScope.run.status).toBe("failed");
        expect(outOfScope.run.error).toContain(
          "Task lifecycle steps only act in their automation's folder",
        );
      }),
    );
  },
);

it.effect("does not auto-start an evaluator automation that was disabled", () => {
  const threads = fakeThreads();
  threads.state.shells["thread-9"] = {
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
  };
  return withEngine(
    { threads },
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const automation = yield* saveOk(waitAutomation);
      yield* engine.setEnabled(automation.id, false);

      const proposed = yield* engine.taskLifecycle({
        threadId: "thread-9",
        action: "propose",
        automationId: automation.id,
        summary: "The requested date passed",
        input: { type: "date", at: "2026-10-18T00:00:00.000Z" },
      });

      expect(proposed.record?.condition).toMatchObject({
        automationId: automation.id,
        summary: "The requested date passed",
        runId: null,
      });
      expect((yield* engine.get(automation.id)).runs).toHaveLength(0);
    }),
  );
});
