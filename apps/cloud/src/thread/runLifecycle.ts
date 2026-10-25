import {
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { driverFor, runnerInstanceFor } from "../models/ModelRouting.ts";
import { queuedRunsInDeliveryOrder } from "./queuedRunCommands.ts";
import { expireRuntimeRequests } from "./runtimeRequests.ts";
import { isLiveRun } from "./runState.ts";
import {
  attemptEvent,
  type DecisionContext,
  ids,
  itemOrdinal,
  messageEvent,
  nodeEvent,
  providerThreadEvent,
  runEvent,
  turnItemEvent,
  threadEvent,
} from "./threadEvents.ts";

/**
 * A run's life on a cloud thread, whoever drives it: start (attempt, root
 * node, the user message's transcript row), finish, and hand the thread to
 * the next queued run. Pure functions of the projection, so a decision
 * repeated after a crash names the same records.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

function wakeWorkStartedAt(
  runs: ReadonlyArray<Run>,
  run: Run,
  message: OrchestrationV2ConversationMessage | undefined,
): DateTime.Utc | undefined {
  if (
    message?.notification === undefined &&
    message?.delegatedCompletion === undefined &&
    run.restartContinuationOfRunId === undefined
  ) {
    return undefined;
  }
  const previous = runs
    .flatMap((candidate) =>
      candidate.startedAt === null ? [] : [{ run: candidate, startedAt: candidate.startedAt }],
    )
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? undefined : orchestrationV2RunWorkStartedAt(previous);
}

/** The run the provider is working on, if any. */
export const activeRun = (projection: Projection): Run | undefined =>
  projection.runs.filter(isLiveRun).toSorted((left, right) => right.ordinal - left.ordinal)[0];

const queuedRuns = queuedRunsInDeliveryOrder;

/** The first queued run that may start once nothing is live. */
export const nextQueuedRun = (projection: Projection): Run | undefined =>
  queuedRuns(projection).find((run) => run.queueHeld !== true);

/**
 * The thread's provider thread as of `run`. A record on the same provider
 * keeps what the harness put there (its native session ref above all); a new
 * one starts without native state and leaves previous provider threads intact.
 */
export const providerThreadFor = (
  projection: Projection,
  run: Run,
  status: OrchestrationV2ProviderThread["status"],
  ctx: DecisionContext,
): OrchestrationV2ProviderThread => {
  const current =
    projection.providerThreads.find((candidate) => candidate.id === run.providerThreadId) ??
    projection.providerThreads
      .filter((candidate) => candidate.ownerNodeId === null)
      .toSorted((left, right) => (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0))[0];
  // A record stored on the harness's own instance (`claudeAgent` for a pool's
  // `claude_hub`) is the same provider: threads saved before the instance was
  // kept keep their session.
  const sameProvider =
    current !== undefined &&
    current.driver === driverFor(run.providerInstanceId) &&
    (current.nativeThreadRef === null || current.nativeThreadRef.driver === current.driver) &&
    (current.providerInstanceId === run.providerInstanceId ||
      current.providerInstanceId === runnerInstanceFor(run.providerInstanceId));
  if (current !== undefined && sameProvider) {
    return {
      ...current,
      providerInstanceId: run.providerInstanceId,
      status,
      lastRunOrdinal: run.ordinal,
      updatedAt: ctx.now,
    };
  }
  return {
    id:
      projection.providerThreads.length === 0
        ? ids.providerThread(projection.thread.id)
        : ids.providerThreadForRun(run.id),
    driver: driverFor(run.providerInstanceId),
    providerInstanceId: run.providerInstanceId,
    providerSessionId: null,
    appThreadId: projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status,
    firstRunOrdinal: run.ordinal,
    lastRunOrdinal: run.ordinal,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
};

/**
 * Hands a run to its provider: its attempt, root node and the user message's
 * transcript row. `run` is the run as it stands (new, or queued until now).
 */
export function startRunEvents(
  projection: Projection,
  run: Run,
  inputIntent: OrchestrationV2UserMessageInputIntent,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = projection.thread.id;
  const attemptId = ids.attempt(run.id);
  const rootNodeId = ids.rootNode(run.id);
  const providerThread = providerThreadFor(projection, run, "active", ctx);
  const providerThreadId = providerThread.id;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  // The timer starts on activation, after any queue wait, and before provider startup.
  const workStartedAt =
    run.workStartedAt ?? wakeWorkStartedAt(projection.runs, run, message) ?? ctx.now;
  const started: Run = {
    ...run,
    status: "starting",
    workStartedAt,
    providerThreadId,
    rootNodeId,
    activeAttemptId: attemptId,
    queuePosition: null,
  };
  const userItem: OrchestrationV2TurnItem = {
    id: ids.userItem(run.id),
    threadId,
    runId: run.id,
    nodeId: rootNodeId,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: itemOrdinal(run.ordinal, 0),
    status: "completed",
    title: null,
    startedAt: run.requestedAt,
    completedAt: run.requestedAt,
    updatedAt: ctx.now,
    type: "user_message",
    createdBy: message?.createdBy ?? "user",
    creationSource: message?.creationSource ?? "web",
    messageId: run.userMessageId,
    inputIntent,
    text: message?.text ?? "",
    attachments: message?.attachments ?? [],
    ...(message?.context === undefined ? {} : { context: message.context }),
  };
  return [
    providerThreadEvent(ctx, threadId, providerThread),
    ...(projection.thread.activeProviderThreadId === providerThreadId
      ? []
      : [
          threadEvent(ctx, "thread.metadata-updated", {
            ...projection.thread,
            activeProviderThreadId: providerThreadId,
            updatedAt: ctx.now,
          }),
        ]),
    runEvent(
      ctx,
      projection.runs.some((candidate) => candidate.id === run.id) ? "run.updated" : "run.created",
      started,
    ),
    attemptEvent(ctx, threadId, "run-attempt.created", {
      id: attemptId,
      runId: run.id,
      attemptOrdinal: 1,
      rootNodeId,
      providerInstanceId: run.providerInstanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: "pending",
      startedAt: null,
      completedAt: null,
    }),
    nodeEvent(ctx, {
      id: rootNodeId,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "pending",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: null,
    }),
    ...(message === undefined ? [] : [messageEvent(ctx, { ...message, nodeId: rootNodeId })]),
    // The system prompt for a machine continuation is provider input, not a transcript row.
    ...(run.restartContinuationOfRunId !== undefined && message?.role === "system"
      ? []
      : [turnItemEvent(ctx, userItem)]),
  ];
}

export type RunEnding = "completed" | "interrupted" | "failed";

/**
 * Ends `run`. `queue` says what the queued runs do: `advance` (the default)
 * starts the next one, `hold` holds them all until `queue.resume`, and `keep`
 * leaves them as they are, for a run that continues this one ahead of them.
 * `leading` events (the provider's last transcript rows) go first, so the
 * transcript settles before the run reads as done.
 */
export function finishRunEvents(
  projection: Projection,
  run: Run,
  status: RunEnding,
  ctx: DecisionContext,
  options: {
    readonly queue?: "advance" | "hold" | "keep";
    readonly leading?: ReadonlyArray<OrchestrationV2DomainEvent>;
  } = {},
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = projection.thread.id;
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const queued = queuedRuns(projection);
  const holdQueue = options.queue === "hold";
  const advanceQueue = (options.queue ?? "advance") === "advance";
  const next = advanceQueue ? queued.find((candidate) => candidate.queueHeld !== true) : undefined;
  // Held runs keep their place when a newer unheld run leaves the queue.
  const remaining = advanceQueue ? queued.filter((candidate) => candidate.id !== next?.id) : [];
  return [
    ...(options.leading ?? []),
    ...expireRuntimeRequests(projection, run.id, ctx, status === "completed"),
    ...projection.turnItems.flatMap((item) =>
      item.runId === run.id &&
      item.id.startsWith(`turn-item:${run.id}:dependencies:`) &&
      item.type === "notification" &&
      (item.status === "running" || item.status === "pending")
        ? [
            turnItemEvent(ctx, {
              ...item,
              status: status === "failed" ? "failed" : "interrupted",
              outcome: status === "failed" ? "failed" : "cancelled",
              summary:
                status === "failed"
                  ? "Dependency setup did not finish before the turn failed."
                  : "This turn ended before dependency setup finished.",
              completedAt: ctx.now,
              updatedAt: ctx.now,
            }),
          ]
        : [],
    ),
    ...(attempt === undefined
      ? []
      : [
          attemptEvent(ctx, threadId, "run-attempt.updated", {
            ...attempt,
            status,
            completedAt: ctx.now,
          }),
        ]),
    runEvent(ctx, "run.updated", { ...run, status, completedAt: ctx.now }),
    ...(node === undefined ? [] : [nodeEvent(ctx, { ...node, status, completedAt: ctx.now })]),
    providerThreadEvent(ctx, threadId, providerThreadFor(projection, run, "idle", ctx)),
    ...(holdQueue
      ? queued.map((candidate) => runEvent(ctx, "run.updated", { ...candidate, queueHeld: true }))
      : []),
    ...(next === undefined ? [] : startRunEvents(projection, next, "queued_turn", ctx)),
    ...remaining.map((candidate, index) =>
      runEvent(ctx, "run.updated", { ...candidate, queuePosition: index + 1 }),
    ),
  ];
}

/** Takes queued `run` out of the queue for good; the ones behind it move up. */
export function cancelQueuedEvents(
  projection: Projection,
  run: Run,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  return [
    runEvent(ctx, "run.updated", {
      ...run,
      status: "cancelled",
      queuePosition: null,
      completedAt: ctx.now,
    }),
    ...queuedRuns(projection)
      .filter((candidate) => candidate.id !== run.id)
      .map((candidate, index) =>
        runEvent(ctx, "run.updated", { ...candidate, queuePosition: index + 1 }),
      ),
  ];
}

/** Releases a held queue: clears the hold and starts the first queued run if nothing is live. */
export function resumeQueueEvents(
  projection: Projection,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const released = queuedRuns(projection).map((run) => ({ ...run, queueHeld: false }));
  const startNow = activeRun(projection) === undefined;
  const [next, ...rest] = startNow ? released : [];
  const waiting = startNow ? rest : released;
  return [
    ...(next === undefined ? [] : startRunEvents(projection, next, "queued_turn", ctx)),
    ...waiting.map((run, index) =>
      runEvent(ctx, "run.updated", { ...run, queuePosition: index + 1 }),
    ),
  ];
}
