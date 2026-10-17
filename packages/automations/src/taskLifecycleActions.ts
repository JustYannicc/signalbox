import { CommandId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { TaskLifecycleInput, TaskLifecycleResult } from "@t3tools/contracts/taskLifecycle";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { fail } from "./errors.ts";
import type { AutomationThreadsShape } from "./host.ts";
import { isTerminalRunStatus } from "./runs.ts";
import type { TaskLifecycleRecords } from "./taskLifecycle.ts";

/** The same lifecycle operation serves clients, agents and automation steps. */
export const makeTaskLifecycleActions = (deps: {
  readonly threads: AutomationThreadsShape;
  readonly records: TaskLifecycleRecords;
}) => {
  const pendingReopenEvents = new Map<string, string>();
  const snapshot = (threadId: string, includeContext = false) =>
    Effect.gen(function* () {
      const id = ThreadId.make(threadId);
      const thread = yield* deps.threads.getThreadShell(id);
      if (thread === null || thread.deletedAt !== null) return yield* fail("This thread is gone.");
      const { runs } = yield* deps.threads.getThreadRecords(id, ["runs"]);
      const messages = includeContext
        ? (yield* deps.threads.getThreadRecords(id, ["messages"])).messages
        : [];
      const kind = deps.threads.getTaskKind
        ? yield* deps.threads.getTaskKind(id)
        : ("task" as const);
      return { thread, messages, runs, kind, record: yield* deps.records.read(threadId) };
    });
  const dispatch = (
    command: Parameters<NonNullable<AutomationThreadsShape["dispatchLifecycle"]>>[0],
  ) =>
    deps.threads.dispatchLifecycle
      ? deps.threads.dispatchLifecycle(command)
      : fail("This environment cannot change task lifecycle yet.");

  const act = (
    input: TaskLifecycleInput,
  ): Effect.Effect<TaskLifecycleResult, import("@t3tools/contracts").AutomationError> =>
    Effect.gen(function* () {
      const current = yield* snapshot(input.threadId, input.includeContext);
      const unchanged = () => ({ ...current, applied: false });
      if (input.action === "read") return unchanged();
      if (current.kind === "chat" && input.action !== "reopen") {
        return yield* fail("Chats have no done-condition. Change this thread to a task first.");
      }
      const resumingCompletion =
        input.action === "complete" &&
        current.record?.reason === null &&
        current.record.settledAt !== null &&
        current.record.outcome === input.outcome &&
        input.expectedGeneration !== undefined &&
        current.record.generation === input.expectedGeneration + 1;
      if (
        input.expectedGeneration !== undefined &&
        input.expectedGeneration !== (current.record?.generation ?? 0) &&
        !resumingCompletion
      )
        return unchanged();
      if (
        input.expectedUpdatedAt !== undefined &&
        DateTime.formatIso(current.thread.updatedAt) !== input.expectedUpdatedAt
      )
        return unchanged();
      if (input.action === "complete") {
        if (!input.outcome?.trim()) return yield* fail("Say the task's one-line outcome.");
        if (
          current.thread.archivedAt !== null ||
          current.runs.some((run) => !isTerminalRunStatus(run.status))
        )
          return unchanged();
        // The record precedes the event so the early-settle automation sees this was automatic.
        const saved = resumingCompletion
          ? { record: current.record, applied: false }
          : yield* deps.records.apply({ ...input, expectedUpdatedAt: undefined });
        if (!saved.applied && !resumingCompletion) return { ...current, ...saved };
        yield* dispatch({
          type: "thread.settle",
          commandId: CommandId.make(
            input.commandId ?? `task:complete:${input.threadId}:${saved.record?.generation}`,
          ),
          threadId: ThreadId.make(input.threadId),
          snapshotAt: current.thread.updatedAt,
        });
        const after = yield* snapshot(input.threadId);
        if (after.thread.archivedAt === null) {
          // A message won the host's snapshot guard. Its new work must not inherit this outcome.
          yield* deps.records.reopen({
            threadId: input.threadId,
            expectedGeneration: saved.record?.generation,
          });
          return { ...(yield* snapshot(input.threadId)), applied: false };
        }
        return { ...after, applied: true };
      }
      if (input.action === "reopen") {
        const needsDispatch =
          current.thread.archivedAt !== null || current.thread.settledOverride === "settled";
        if (needsDispatch)
          yield* dispatch({
            ...(current.thread.settledOverride === "settled"
              ? { type: "thread.unsettle" as const, reason: "user" as const }
              : { type: "thread.unarchive" as const }),
            threadId: ThreadId.make(input.threadId),
            commandId: CommandId.make(
              input.commandId ?? `task:reopen:${input.threadId}:${current.record?.generation ?? 0}`,
            ),
          });
        const saved = yield* deps.records.apply({ ...input, expectedUpdatedAt: undefined });
        const after = yield* snapshot(input.threadId);
        if (needsDispatch)
          pendingReopenEvents.set(input.threadId, DateTime.formatIso(after.thread.updatedAt));
        return {
          ...after,
          applied:
            saved.applied ||
            current.thread.archivedAt !== null ||
            current.thread.settledOverride === "settled",
        };
      }
      if (
        input.action === "record-settle" &&
        current.thread.archivedAt === null &&
        current.thread.settledOverride !== "settled"
      )
        return unchanged();
      if (input.action === "propose") {
        // The editable condition now owns completion; the upstream merge sweep must not race it.
        yield* dispatch({
          type: "thread.auto-settle.set",
          enabled: false,
          commandId: CommandId.make(
            input.commandId
              ? `${input.commandId}:own-completion`
              : `task:own:${input.threadId}:${current.record?.generation ?? 0}`,
          ),
          threadId: ThreadId.make(input.threadId),
        });
      }
      const saved = yield* deps.records.apply({ ...input, expectedUpdatedAt: undefined });
      return { ...(yield* snapshot(input.threadId)), applied: saved.applied };
    }).pipe(
      Effect.withSpan("TaskLifecycle.act", {
        attributes: { "thread.id": input.threadId, "task.action": input.action },
      }),
    );

  /** A message or explicit reopen invalidates outcomes from an earlier settlement. */
  const onDomainEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "thread.unsettled" || event.type === "thread.unarchived"
      ? Effect.suspend(() => {
          const pendingAt = pendingReopenEvents.get(event.threadId);
          const eventAt = DateTime.formatIso(event.payload.updatedAt);
          if (pendingAt !== undefined) pendingReopenEvents.delete(event.threadId);
          if (pendingAt === eventAt) {
            return Effect.succeed(false);
          }
          return deps.records
            .reopen({ threadId: event.threadId, commandId: `event:${event.id}` })
            .pipe(Effect.map(({ applied }) => applied));
        })
      : Effect.succeed(false);
  return { act, onDomainEvent };
};

export type TaskLifecycleActions = ReturnType<typeof makeTaskLifecycleActions>;
