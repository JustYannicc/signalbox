import {
  type ModelSelection,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isHarnessInstance } from "../models/ModelRouting.ts";
import { decideLifecycleCommand } from "./lifecycleCommands.ts";
import { pullRequestLinkEvents } from "./pullRequests/pullRequestLinks.ts";
import {
  activeRun,
  cancelQueuedEvents,
  resumeQueueEvents,
  startRunEvents,
} from "./runLifecycle.ts";
import { answerRequestEvents } from "./runtimeRequests.ts";
import { interruptRunEvents } from "./scriptedTurn.ts";
import { canSteer, steerEvents, steerTarget } from "./steering.ts";
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

export const HARNESS_MODES_UNSUPPORTED =
  "Claude and Codex in the cloud run with full access and without plan mode for now: approvals can't reach cloud machines yet.";

/** A thread's own branch, and the path clients address its working tree by. */
export interface ThreadWorktree {
  readonly branch: string;
  readonly path: string;
}

/** The rejection for a command the cloud does not serve yet. */
export const unsupported = (commandType: string) =>
  `${commandType} is not available in the cloud yet.`;

const CLOUD_COMMAND_TYPES = [
  "thread.create",
  "message.dispatch",
  "run.interrupt",
  "queue.resume",
  "queued-run.cancel",
  "queued-message.promote-to-steer",
  "thread.visit",
  "thread.metadata.update",
  "thread.model-selection.set",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.pull-request.link",
  "thread.pull-request.unlink",
  "thread.pull-request-link.sync",
  "thread.archive",
  "thread.unarchive",
  "runtime-request.respond",
  "thread.settle",
  "thread.auto-settle",
  "thread.unsettle",
  "thread.auto-settle.set",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
] as const satisfies ReadonlyArray<OrchestrationV2Command["type"]>;
type CloudCommand = CommandOf<(typeof CLOUD_COMMAND_TYPES)[number]>;

/**
 * The commands `decide` serves; its switch is exhaustive over them. The public
 * API lists the rest as gaps (`api/cloudCoverage.ts`).
 */
export const CLOUD_COMMANDS: ReadonlySet<OrchestrationV2Command["type"]> = new Set(
  CLOUD_COMMAND_TYPES,
);

const isCloudCommand = (command: OrchestrationV2Command): command is CloudCommand =>
  CLOUD_COMMANDS.has(command.type);

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
  if (current.archivedAt !== null) {
    current = { ...current, archivedAt: null, updatedAt: ctx.now };
    updates.push(threadEvent(ctx, "thread.unarchived", current));
  }
  if (current.settledOverride !== null || current.settledAt !== null) {
    current = {
      ...current,
      settledOverride: null,
      settledAt: null,
      unsettledAt: current.settledOverride === "active" ? current.unsettledAt : ctx.now,
      updatedAt: ctx.now,
    };
    updates.push(threadEvent(ctx, "thread.unsettled", current));
  }
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

  // Cloud machines have no way to answer an approval or a question yet, so a
  // harness turn that could stop to ask would wait until someone pressed Stop.
  if (
    isHarnessInstance(current.providerInstanceId) &&
    (current.runtimeMode !== "full-access" || current.interactionMode === "plan")
  ) {
    return reject(HARNESS_MODES_UNSUPPORTED);
  }

  const ordinal = projection.runs.length + 1;
  const runId = ids.run(thread.id, ordinal);
  const live = activeRun(projection);
  const message: OrchestrationV2ConversationMessage = {
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
    ...(command.notification === undefined ? {} : { notification: command.notification }),
    ...(command.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: command.delegatedCompletion }),
    ...(command.context === undefined ? {} : { context: command.context }),
    attachments: command.attachments,
    streaming: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  const steered = steerTarget(projection, command);
  if (steered !== undefined) {
    return accept([...updates, ...steerEvents(projection, steered, message, "steer", ctx)]);
  }
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
    // A message that doesn't steer the live turn waits its turn.
    status: live === undefined ? "starting" : "queued",
    queuePosition: live === undefined ? null : queuePosition,
    requestedAt: ctx.now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    ...(command.restartContinuationOfRunId === undefined
      ? {}
      : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
  };
  const recorded = messageEvent(ctx, message);
  if (live !== undefined) {
    return accept([...updates, runEvent(ctx, "run.created", run), recorded]);
  }
  const withMessage = applyEvents(projection, [...updates, recorded]) ?? projection;
  return accept([...updates, recorded, ...startRunEvents(withMessage, run, "turn_start", ctx)]);
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
  /** `idleSinceMs`: archive only a thread unchanged since then (the idle-chat sweep's). */
  expected: { readonly idleSinceMs?: number } = {},
): Decision {
  if (!isCloudCommand(command)) return reject(unsupported(command.type));
  if (command.type === "thread.create") {
    return projection === null ? createThread(command, ctx) : reject("This thread already exists.");
  }
  if (projection === null) return reject("This thread does not exist.");
  if (projection.thread.deletedAt !== null) return reject("This thread was deleted.");
  switch (command.type) {
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
      return decideLifecycleCommand(projection, command, ctx) ?? reject(unsupported(command.type));
    case "message.dispatch":
      return dispatchMessage(projection, command, ctx);
    case "run.interrupt": {
      const run = activeRun(projection);
      if (run === undefined || run.id !== command.runId) {
        return reject("That run is not running.");
      }
      return accept(interruptRunEvents(projection, run, ctx, command.holdQueue === true));
    }
    case "queued-run.cancel": {
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      if (run?.status !== "queued") return reject("That message is no longer queued.");
      return accept(cancelQueuedEvents(projection, run, ctx));
    }
    case "queued-message.promote-to-steer": {
      const queued = projection.runs.find((candidate) => candidate.id === command.queuedRunId);
      const message = projection.messages.find(
        (candidate) => candidate.id === queued?.userMessageId,
      );
      if (queued?.status !== "queued" || message === undefined) {
        return reject("That message is no longer queued.");
      }
      const target = activeRun(projection);
      if (
        target === undefined ||
        target.id !== command.targetRunId ||
        !canSteer(projection, target, queued.modelSelection)
      ) {
        return reject("The running turn can't take a message right now; it stays queued.");
      }
      const cancelled = cancelQueuedEvents(projection, queued, ctx);
      const withoutQueued = applyEvents(projection, cancelled) ?? projection;
      return accept([
        ...cancelled,
        ...steerEvents(withoutQueued, target, message, "promoted_queued_to_steer", ctx),
      ]);
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
    // As upstream's: archiving twice or bringing back a thread that isn't
    // archived is refused. A thread mid-turn isn't archived from under its
    // agent. Both move the thread's `updatedAt`, so a chat brought back waits
    // its full idle time again before it archives itself (#46).
    case "thread.archive":
      if (projection.thread.archivedAt !== null) return reject("This thread is already archived.");
      if (activeRun(projection) !== undefined) {
        return reject("This thread is still working. Stop it or let it finish, then archive it.");
      }
      if (
        expected.idleSinceMs !== undefined &&
        DateTime.toEpochMillis(projection.updatedAt) > expected.idleSinceMs
      ) {
        return reject("This thread changed since it went idle.");
      }
      return updateThread(projection, "thread.archived", { archivedAt: ctx.now }, ctx);
    case "thread.unarchive":
      if (projection.thread.archivedAt === null) return reject("This thread is not archived.");
      return updateThread(projection, "thread.unarchived", { archivedAt: null }, ctx);
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
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
      return accept(pullRequestLinkEvents(projection, command, ctx));
    // What the thread asked its person (`runtimeRequests.ts`).
    case "runtime-request.respond": {
      const answered = answerRequestEvents(projection, command.requestId, command.decision, ctx);
      return typeof answered === "string" ? reject(answered) : accept(answered);
    }
    default:
      return command satisfies never;
  }
}

/**
 * `launchThread`: create the thread and send its first message, decided as
 * one command so a retried launch never creates a thread without its turn.
 */
export function decideLaunch(
  projection: Projection | null,
  input: OrchestrationV2ThreadLaunchInput & {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
  },
  ctx: DecisionContext,
  worktree: ThreadWorktree | null = null,
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
            branch: worktree?.branch ?? null,
            worktreePath: worktree?.path ?? null,
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
