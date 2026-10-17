import {
  AutomationError,
  ProjectId,
  ThreadId,
  type AutomationDefaults,
  type AutomationRunAttach,
  type AutomationRunSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Semaphore from "effect/Semaphore";

import type { TaskLifecycleInput, TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";

import { fail } from "./errors.ts";
import type { AutomationThreadsShape } from "./host.ts";
import type { Attachments } from "./attachments.ts";
import { asRecord, fromJson } from "./json.ts";
import { builtInById } from "./defaults/registry.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import type { TaskLifecycleActions } from "./taskLifecycleActions.ts";
import type { TaskLifecycleRecords } from "./taskLifecycle.ts";
import type { WorkflowStore } from "./WorkflowStore.ts";

type StartRun = (input: {
  readonly automationId: string;
  readonly input?: unknown;
  readonly trigger: "manual";
  readonly attach?: AutomationRunAttach;
  readonly projectId?: string;
  readonly builtInDefaults?: AutomationDefaults;
}) => Effect.Effect<AutomationRunSummary, AutomationError>;

/** Owns the run side of task lifecycle state, including event/action races. */
export const makeTaskLifecycleRuns = (deps: {
  readonly actions: TaskLifecycleActions;
  readonly records: TaskLifecycleRecords;
  readonly links: RunLinkStore;
  readonly store: WorkflowStore;
  readonly threads: AutomationThreadsShape;
  readonly attachments: Attachments;
  readonly startRun: StartRun;
  readonly endRunById: (runId: string) => Effect.Effect<boolean, AutomationError>;
}) => {
  const lanes = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  const serialized = <A, E>(threadId: string, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      let lane = lanes.get(threadId);
      if (!lane) {
        lane = { lock: Semaphore.makeUnsafe(1), users: 0 };
        lanes.set(threadId, lane);
      }
      lane.users++;
      return lane.lock
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lane!.users--;
              if (lane!.users === 0 && lanes.get(threadId) === lane) lanes.delete(threadId);
            }),
          ),
        );
    });

  const cancelConditionRuns = (threadId: string, runId?: string, except?: string) =>
    Effect.gen(function* () {
      const ids = new Set<string>();
      if (runId && runId !== except) ids.add(runId);
      for (const link of yield* deps.links.runningAttachedTo(threadId)) {
        if (link.attach_key === "done-condition" && link.run_id !== except) ids.add(link.run_id);
      }
      for (const id of ids) yield* deps.endRunById(id);
    });

  const validateAdoption = (input: TaskLifecycleInput) =>
    Effect.gen(function* () {
      if (input.runId == null) return;
      const threadId = ThreadId.make(input.threadId);
      const shell = yield* deps.threads.getThreadShell(threadId);
      const run = yield* deps.store.getRun(input.runId);
      if (!shell || shell.deletedAt !== null || !run || run.status !== "running")
        return yield* fail("The done-condition run is no longer available.");
      const automation = yield* deps.store.getAutomation(run.automation_id);
      if (!automation || automation.project_id !== shell.projectId)
        return yield* fail("The done-condition run belongs to another project.");
      const existing = yield* deps.links.getLink(input.runId);
      const runInput = asRecord(fromJson(run.input_json));
      const belongsToThread =
        (existing?.thread_id === input.threadId && existing.attach_key === "done-condition") ||
        runInput.threadId === input.threadId;
      if (!belongsToThread)
        return yield* fail("The done-condition run wasn't started for this task.");
      if (
        existing &&
        !(existing.thread_id === input.threadId && existing.attach_key === "done-condition") &&
        (existing.thread_id !== null || existing.attach_key !== null)
      )
        return yield* fail("The done-condition run is attached somewhere else.");
      return { run };
    });

  const adoptRun = (input: TaskLifecycleInput, result: TaskLifecycleResult) =>
    Effect.gen(function* () {
      if (input.runId == null || !result.record?.condition) return;
      const validation = yield* validateAdoption(input);
      if (!validation) return;
      for (const otherRunId of yield* deps.store.runningRunsOf(validation.run.automation_id)) {
        if (otherRunId === input.runId) continue;
        const other = yield* deps.store.getRun(otherRunId);
        if (!other) continue;
        const otherInput = asRecord(fromJson(other.input_json));
        if (otherInput.threadId === input.threadId) yield* deps.endRunById(otherRunId);
      }
      yield* deps.links.adoptAttachment({
        runId: input.runId,
        threadId: input.threadId,
        key: "done-condition",
        label: `Done when: ${result.record.condition.summary}`,
        startedAt: validation.run.started_at,
      });
      yield* deps.attachments.refresh(input.runId);
      const saved = yield* deps.records.setConditionRunId(
        input.threadId,
        result.record.generation,
        input.runId,
      );
      if (!saved) yield* deps.endRunById(input.runId);
    });

  const startConditionRun = (threadId: string, expectedGeneration: number, allowPaused = false) =>
    Effect.gen(function* () {
      const record = yield* deps.records.read(threadId);
      const condition = record?.condition;
      if (
        !record ||
        record.generation !== expectedGeneration ||
        record.settledAt !== null ||
        !condition?.input
      )
        return;
      const id = ThreadId.make(threadId);
      const shell = yield* deps.threads.getThreadShell(id);
      if (
        !shell ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null ||
        shell.settledOverride === "settled"
      )
        return;
      if (deps.threads.getTaskKind && (yield* deps.threads.getTaskKind(id)) !== "task") return;
      const automationId = condition.automationId ?? "builtin:task-done";
      const builtIn = builtInById(automationId);
      const automation = builtIn
        ? yield* deps.store.getAutomationByName(shell.projectId, builtIn.name)
        : yield* deps.store.getAutomation(automationId);
      if (
        (automation !== undefined && automation.project_id !== shell.projectId) ||
        (!automation && !(allowPaused && builtIn)) ||
        (!allowPaused && (!automation || automation.enabled !== 1))
      )
        return;
      const run = yield* deps.startRun({
        automationId,
        input: {
          threadId,
          condition: condition.input,
          summary: condition.summary,
          expectedGeneration,
        },
        trigger: "manual",
        attach: {
          threadId: id,
          key: "done-condition",
          label: `Done when: ${condition.summary}`,
        },
        projectId: ProjectId.make(shell.projectId),
        builtInDefaults: {
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
        },
      });
      if (!(yield* deps.records.setConditionRunId(threadId, expectedGeneration, run.id)))
        yield* deps.endRunById(run.id);
    });

  const cancelSettleClassifier = (threadId: string) =>
    Effect.gen(function* () {
      const shell = yield* deps.threads.getThreadShell(ThreadId.make(threadId));
      if (!shell) return;
      const automation = yield* deps.store.getAutomationByName(shell.projectId, "Settle task");
      if (!automation) return;
      for (const runId of yield* deps.store.runningRunsOf(automation.automation_id)) {
        const run = yield* deps.store.getRun(runId);
        if (!run) continue;
        const input = asRecord(fromJson(run.input_json));
        if (input.threadId === threadId) yield* deps.endRunById(runId);
      }
    });

  const reopenAndRearm = (threadId: string, priorRunId?: string) =>
    Effect.gen(function* () {
      const current = yield* deps.records.read(threadId);
      yield* cancelConditionRuns(threadId, priorRunId);
      yield* cancelSettleClassifier(threadId);
      if (current?.condition) yield* startConditionRun(threadId, current.generation);
    });

  const act = (input: TaskLifecycleInput) =>
    serialized(
      input.threadId,
      Effect.gen(function* () {
        const prior = yield* deps.records.read(input.threadId);
        if (input.action === "propose" && input.runId != null) yield* validateAdoption(input);
        const result = yield* deps.actions.act(input);
        if (!result.applied) {
          // A completion can lose the host's snapshot guard to a new message before settle.
          if (
            input.action === "complete" &&
            prior?.condition &&
            result.record &&
            result.record.generation > prior.generation &&
            result.record.settledAt === null
          )
            yield* reopenAndRearm(input.threadId, prior.condition.runId ?? undefined);
          else if (
            input.action === "complete" &&
            input.expectedUpdatedAt !== undefined &&
            input.expectedGeneration === prior?.generation &&
            DateTime.formatIso(result.thread.updatedAt) !== input.expectedUpdatedAt &&
            prior?.condition &&
            result.record?.generation === prior.generation &&
            result.record.settledAt === null
          )
            // The thread changed before the record write. Keep one evaluator on the latest turn.
            yield* reopenAndRearm(input.threadId, prior.condition.runId ?? undefined);
          return { ...result, record: yield* deps.records.read(input.threadId) };
        }
        if (input.action === "propose" && result.record?.condition) {
          yield* cancelConditionRuns(
            input.threadId,
            prior?.condition?.runId ?? undefined,
            input.runId ?? undefined,
          );
          if (input.runId == null)
            yield* startConditionRun(input.threadId, result.record.generation, true);
          else yield* adoptRun(input, result);
        } else if (input.action === "record-settle" && result.record?.condition) {
          yield* cancelConditionRuns(input.threadId, result.record.condition.runId ?? undefined);
        } else if (
          input.action === "reopen" &&
          result.record?.condition &&
          result.record.generation > (prior?.generation ?? 0)
        ) {
          yield* reopenAndRearm(input.threadId, prior?.condition?.runId ?? undefined);
        }
        return { ...result, record: yield* deps.records.read(input.threadId) };
      }),
    );

  const onDomainEvent = (event: Parameters<TaskLifecycleActions["onDomainEvent"]>[0]) => {
    if (event.type === "thread.unsettled" || event.type === "thread.unarchived")
      return serialized(
        event.threadId,
        Effect.gen(function* () {
          const prior = yield* deps.records.read(event.threadId);
          const changed = yield* deps.actions.onDomainEvent(event);
          if (changed) yield* reopenAndRearm(event.threadId, prior?.condition?.runId ?? undefined);
        }),
      );

    if (
      event.type === "message.updated" &&
      event.payload.role === "user" &&
      !event.payload.streaming
    )
      return serialized(
        event.threadId,
        Effect.gen(function* () {
          const prior = yield* deps.records.read(event.threadId);
          if (!prior?.condition || prior.settledAt !== null) return;
          const threadId = ThreadId.make(event.threadId);
          const shell = yield* deps.threads.getThreadShell(threadId);
          if (
            !shell ||
            shell.deletedAt !== null ||
            shell.archivedAt !== null ||
            shell.settledOverride === "settled"
          )
            return;
          if (deps.threads.getTaskKind && (yield* deps.threads.getTaskKind(threadId)) !== "task")
            return;
          const reopened = yield* deps.records.reopen({
            threadId: event.threadId,
            commandId: `event:${event.id}`,
          });
          if (reopened.applied)
            yield* reopenAndRearm(event.threadId, prior.condition.runId ?? undefined);
        }),
      );

    return Effect.void;
  };

  return { act, onDomainEvent };
};

export type TaskLifecycleRuns = ReturnType<typeof makeTaskLifecycleRuns>;
