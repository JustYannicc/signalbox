import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  activeRun,
  interruptRunEvents,
  resumeQueueEvents,
  startRunEvents,
} from "./scriptedTurn.ts";
import { type DecisionContext, ids, messageEvent, runEvent, threadEvent } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";

/**
 * Decides a client command against a cloud thread's projection. Pure: the
 * same projection and command always give the same events, and nothing here
 * performs I/O. Upstream's orchestrator decides the same commands but reads
 * its state from SQL and a dozen services, so the shapes of its events are
 * followed here rather than its code.
 */

export type Decision =
  | { readonly _tag: "accepted"; readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }
  | { readonly _tag: "rejected"; readonly message: string };

const accept = (events: ReadonlyArray<OrchestrationV2DomainEvent>): Decision => ({
  _tag: "accepted",
  events,
});
const reject = (message: string): Decision => ({ _tag: "rejected", message });

type Projection = OrchestrationV2ThreadProjection;
type CommandOf<T extends OrchestrationV2Command["type"]> = Extract<
  OrchestrationV2Command,
  { readonly type: T }
>;

/** The rejection for a command the cloud does not serve yet. */
export const unsupported = (commandType: string) =>
  `${commandType} is not available in the cloud yet.`;

/** The thread a command addresses. Commands without a single target thread are not served. */
export function commandThreadId(command: OrchestrationV2Command) {
  return "threadId" in command ? command.threadId : null;
}

function createThread(command: CommandOf<"thread.create">, ctx: DecisionContext): Decision {
  if (command.importedNativeThread !== undefined) {
    return reject("Importing native threads is not available in the cloud yet.");
  }
  const thread: OrchestrationV2AppThread = {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    id: command.threadId,
    projectId: command.projectId,
    title: command.title,
    providerInstanceId: command.modelSelection.instanceId,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    branch: command.branch,
    worktreePath: command.worktreePath,
    activeProviderThreadId: null,
    historyOrigin: "native",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: command.threadId },
    forkedFrom: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return accept([threadEvent(ctx, "thread.created", thread)]);
}

function dispatchMessage(
  projection: Projection,
  command: CommandOf<"message.dispatch">,
  ctx: DecisionContext,
): Decision {
  if (command.dispatchMode.type === "defer_start") {
    return reject("Deferred starts are not available in the cloud yet.");
  }
  const { thread } = projection;
  const updates: Array<OrchestrationV2DomainEvent> = [];
  let current = thread;
  const firstMessage = !projection.messages.some((message) => message.role === "user");
  if (command.titleSeed !== undefined && firstMessage && command.titleSeed !== thread.title) {
    current = { ...current, title: command.titleSeed, updatedAt: ctx.now };
    updates.push(threadEvent(ctx, "thread.metadata-updated", current));
  }
  if (
    command.modelSelection !== undefined &&
    (command.modelSelection.model !== thread.modelSelection.model ||
      command.modelSelection.instanceId !== thread.modelSelection.instanceId)
  ) {
    current = {
      ...current,
      modelSelection: command.modelSelection,
      providerInstanceId: command.modelSelection.instanceId,
      updatedAt: ctx.now,
    };
    updates.push(threadEvent(ctx, "thread.model-selection-updated", current));
  }

  const ordinal = projection.runs.length + 1;
  const runId = ids.run(thread.id, ordinal);
  const live = activeRun(projection);
  const queuePosition = projection.runs.filter((run) => run.status === "queued").length + 1;
  const run: OrchestrationV2Run = {
    id: runId,
    threadId: thread.id,
    ordinal,
    providerInstanceId: current.providerInstanceId,
    modelSelection: current.modelSelection,
    providerThreadId: null,
    userMessageId: command.messageId,
    rootNodeId: null,
    activeAttemptId: null,
    // The scripted provider cannot steer or restart a live turn, so any
    // message that arrives while one runs waits its turn.
    status: live === undefined ? "starting" : "queued",
    queuePosition: live === undefined ? null : queuePosition,
    requestedAt: ctx.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const message = messageEvent(ctx, {
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    ...(command.scheduledTaskId === undefined ? {} : { scheduledTaskId: command.scheduledTaskId }),
    ...(command.senderThreadId === undefined ? {} : { senderThreadId: command.senderThreadId }),
    id: command.messageId,
    threadId: thread.id,
    runId,
    nodeId: null,
    role: "user",
    text: command.text,
    ...(command.context === undefined ? {} : { context: command.context }),
    attachments: command.attachments,
    streaming: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  if (live !== undefined) {
    return accept([...updates, runEvent(ctx, "run.created", run), message]);
  }
  const withMessage = applyEvents(projection, [...updates, message]) ?? projection;
  return accept([...updates, message, ...startRunEvents(withMessage, run, "turn_start", ctx)]);
}

function updateThread(
  projection: Projection,
  type: Parameters<typeof threadEvent>[1],
  patch: Partial<OrchestrationV2AppThread>,
  ctx: DecisionContext,
): Decision {
  return accept([threadEvent(ctx, type, { ...projection.thread, ...patch, updatedAt: ctx.now })]);
}

/**
 * The commands a cloud thread serves today. Anything else is rejected with a
 * message the client shows, never silently dropped.
 */
export function decide(
  projection: Projection | null,
  command: OrchestrationV2Command,
  ctx: DecisionContext,
): Decision {
  if (command.type === "thread.create") {
    return projection === null ? createThread(command, ctx) : reject("This thread already exists.");
  }
  if (projection === null) return reject("This thread does not exist.");
  if (projection.thread.deletedAt !== null) return reject("This thread was deleted.");
  switch (command.type) {
    case "message.dispatch":
      return dispatchMessage(projection, command, ctx);
    case "run.interrupt": {
      const run = activeRun(projection);
      if (run === undefined || run.id !== command.runId) {
        return reject("That run is not running.");
      }
      return accept(interruptRunEvents(projection, run, ctx, command.holdQueue === true));
    }
    case "queue.resume": {
      const events = resumeQueueEvents(projection, ctx);
      return events.length === 0 ? reject("No queued messages are held.") : accept(events);
    }
    case "thread.visit": {
      const visitedAt = DateTime.makeUnsafe(command.visitedAt);
      const stored = projection.thread.lastVisitedAt;
      // The watermark only moves forward, so replays and late deliveries are harmless.
      const next =
        stored !== null && DateTime.toEpochMillis(stored) >= DateTime.toEpochMillis(visitedAt)
          ? stored
          : visitedAt;
      return accept([
        threadEvent(ctx, "thread.visited", { ...projection.thread, lastVisitedAt: next }),
      ]);
    }
    case "thread.metadata.update": {
      if (
        command.branch != null ||
        command.worktreePath != null ||
        command.limitRecovery != null ||
        command.linkedPullRequest != null ||
        command.regenerateTitle === true
      ) {
        return reject("Only the title can change on a cloud thread yet.");
      }
      if (command.expectedEmpty === true && projection.messages.length > 0) {
        return reject("This thread already has messages.");
      }
      return command.title === undefined
        ? accept([])
        : updateThread(projection, "thread.metadata-updated", { title: command.title }, ctx);
    }
    case "thread.model-selection.set":
      return updateThread(
        projection,
        "thread.model-selection-updated",
        {
          modelSelection: command.modelSelection,
          providerInstanceId: command.modelSelection.instanceId,
        },
        ctx,
      );
    case "thread.runtime-mode.set":
      return updateThread(
        projection,
        "thread.runtime-mode-updated",
        { runtimeMode: command.runtimeMode },
        ctx,
      );
    case "thread.interaction-mode.set":
      return updateThread(
        projection,
        "thread.interaction-mode-updated",
        { interactionMode: command.interactionMode },
        ctx,
      );
    default:
      return reject(unsupported(command.type));
  }
}

/**
 * `launchThread`: create the thread and send its first message, decided as
 * one command so a retried launch never creates a thread without its turn.
 */
export function decideLaunch(
  projection: Projection | null,
  input: OrchestrationV2ThreadLaunchInput & { readonly threadId: ThreadId },
  ctx: DecisionContext,
): Decision {
  if (input.workspaceStrategy.type !== "root") {
    return reject("Cloud threads have no worktrees yet.");
  }
  if (projection !== null && input.reuseExistingThread !== true) {
    return reject("This thread already exists.");
  }
  const creationSource = input.creationSource ?? "web";
  const created =
    projection === null
      ? createThread(
          {
            type: "thread.create",
            commandId: input.commandId,
            createdBy: "user",
            creationSource,
            threadId: input.threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
          },
          ctx,
        )
      : accept([]);
  const message = input.initialMessage;
  if (created._tag === "rejected" || message === undefined) return created;
  const withThread = applyEvents(projection, created.events);
  if (withThread === null) return reject("This thread does not exist.");
  const sent = dispatchMessage(
    withThread,
    {
      type: "message.dispatch",
      commandId: input.commandId,
      createdBy: "user",
      creationSource,
      threadId: input.threadId,
      messageId: message.messageId ?? MessageId.make(`message:${input.commandId}`),
      text: message.text,
      ...(message.context === undefined ? {} : { context: message.context }),
      attachments: message.attachments,
      modelSelection: input.modelSelection,
      dispatchMode: { type: "start_immediately" },
    },
    ctx,
  );
  return sent._tag === "rejected" ? sent : accept([...created.events, ...sent.events]);
}
