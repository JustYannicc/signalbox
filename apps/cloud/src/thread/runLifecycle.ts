import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";

import { driverFor } from "./providerCatalog.ts";
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
} from "./threadEvents.ts";

/**
 * A run's life on a cloud thread, whoever drives it: start (attempt, root
 * node, the user message's transcript row), finish, and hand the thread to
 * the next queued run. Pure functions of the projection, so a decision
 * repeated after a crash names the same records.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

type LiveRun = Run & { readonly status: "preparing" | "starting" | "running" | "waiting" };

/** A run the provider is (or is about to be) working on. */
export const isLiveRun = (run: Run): run is LiveRun =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

/** The run the provider is working on, if any. */
export const activeRun = (projection: Projection): Run | undefined =>
  projection.runs.filter(isLiveRun).toSorted((left, right) => right.ordinal - left.ordinal)[0];

const queuedRuns = (projection: Projection): ReadonlyArray<Run> =>
  projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => left.ordinal - right.ordinal);

/** The first queued run that may start once nothing is live. */
export const nextQueuedRun = (projection: Projection): Run | undefined =>
  queuedRuns(projection).find((run) => run.queueHeld !== true);

/**
 * The thread's provider thread as of `run`. A record on the same provider
 * keeps what the harness put there (its native session ref above all); a new
 * one, or one the thread switched provider on, starts without native state.
 */
export const providerThreadFor = (
  projection: Projection,
  run: Run,
  status: OrchestrationV2ProviderThread["status"],
  ctx: DecisionContext,
): OrchestrationV2ProviderThread => {
  const id = ids.providerThread(projection.thread.id);
  const current = projection.providerThreads.find((candidate) => candidate.id === id);
  if (current?.providerInstanceId === run.providerInstanceId) {
    return { ...current, status, lastRunOrdinal: run.ordinal, updatedAt: ctx.now };
  }
  return {
    id,
    driver: driverFor(run.providerInstanceId),
    providerInstanceId: run.providerInstanceId,
    providerSessionId: null,
    appThreadId: projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status,
    firstRunOrdinal: current?.firstRunOrdinal ?? run.ordinal,
    lastRunOrdinal: run.ordinal,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: current?.createdAt ?? ctx.now,
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
  const providerThreadId = ids.providerThread(threadId);
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  const started: Run = {
    ...run,
    status: "starting",
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
    providerThreadEvent(ctx, threadId, providerThreadFor(projection, run, "active", ctx)),
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
    turnItemEvent(ctx, userItem),
  ];
}

export type RunEnding = "completed" | "interrupted" | "failed";

/**
 * Ends `run` and starts the next queued run unless the queue is held.
 * `leading` events (the provider's last transcript rows) go first, so the
 * transcript settles before the run reads as done.
 */
export function finishRunEvents(
  projection: Projection,
  run: Run,
  status: RunEnding,
  ctx: DecisionContext,
  options: {
    readonly holdQueue?: boolean;
    readonly leading?: ReadonlyArray<OrchestrationV2DomainEvent>;
  } = {},
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = projection.thread.id;
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const queued = queuedRuns(projection);
  const holdQueue = options.holdQueue === true;
  const [next, ...rest] = holdQueue
    ? []
    : queued.filter((candidate) => candidate.queueHeld !== true);
  return [
    ...(options.leading ?? []),
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
    ...rest.map((candidate, index) =>
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
