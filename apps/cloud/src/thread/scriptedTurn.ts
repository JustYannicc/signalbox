import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";

import { nextScriptedPrefix, SCRIPTED_DRIVER, scriptedReply } from "./scriptedProvider.ts";
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
 * A run's life on the scripted provider, decided from the projection alone:
 * start, stream one chunk per step, complete, or be interrupted, then hand the
 * thread to the next queued run. Every step is a pure function of what the
 * thread's events already say, so replaying a step after a crash either
 * repeats nothing (the step landed) or produces the same events (it did not).
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

/** Whether a step has anything to do: a live run to drive, or a queued one ready to start. */
export const hasPendingTurnWork = (projection: Projection): boolean =>
  activeRun(projection) !== undefined ||
  queuedRuns(projection).some((run) => run.queueHeld !== true);

const providerThread = (
  projection: Projection,
  run: Run,
  status: OrchestrationV2ProviderThread["status"],
  ctx: DecisionContext,
): OrchestrationV2ProviderThread => {
  const id = ids.providerThread(projection.thread.id);
  const current = projection.providerThreads.find((candidate) => candidate.id === id);
  return {
    id,
    driver: current?.driver ?? SCRIPTED_DRIVER,
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
 * Hands a run to the provider: its attempt, root node and the user message's
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
    providerThreadEvent(ctx, threadId, providerThread(projection, run, "active", ctx)),
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

const assistantItemOf = (projection: Projection, run: Run) =>
  projection.turnItems.find(
    (item): item is Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> =>
      item.id === ids.assistantItem(run.id) && item.type === "assistant_message",
  );

const assistantItem = (
  projection: Projection,
  run: Run,
  text: string,
  status: OrchestrationV2TurnItem["status"],
  ctx: DecisionContext,
): OrchestrationV2TurnItem => {
  const current = assistantItemOf(projection, run);
  const done = status !== "running";
  return {
    id: ids.assistantItem(run.id),
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: itemOrdinal(run.ordinal, 1),
    status,
    title: null,
    startedAt: current?.startedAt ?? ctx.now,
    completedAt: done ? ctx.now : null,
    updatedAt: ctx.now,
    type: "assistant_message",
    messageId: ids.assistantMessage(run.id),
    text,
    streaming: !done,
  };
};

/** Ends `run` (completed or interrupted) and starts the next queued run unless the queue is held. */
function finishRunEvents(
  projection: Projection,
  run: Run,
  status: "completed" | "interrupted",
  ctx: DecisionContext,
  options: { readonly holdQueue?: boolean } = {},
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = projection.thread.id;
  const current = assistantItemOf(projection, run);
  const finalText =
    status === "completed" ? scriptedReply(userTextOf(projection, run)) : (current?.text ?? "");
  const assistant =
    status === "completed" || current !== undefined
      ? [
          turnItemEvent(ctx, assistantItem(projection, run, finalText, status, ctx)),
          messageEvent(ctx, {
            createdBy: "agent",
            creationSource: "provider",
            id: ids.assistantMessage(run.id),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            role: "assistant",
            text: finalText,
            attachments: [],
            streaming: false,
            createdAt: current?.startedAt ?? ctx.now,
            updatedAt: ctx.now,
          }),
        ]
      : [];
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const queued = queuedRuns(projection);
  const holdQueue = options.holdQueue === true;
  const [next, ...rest] = holdQueue
    ? []
    : queued.filter((candidate) => candidate.queueHeld !== true);
  return [
    ...assistant,
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
    providerThreadEvent(ctx, threadId, providerThread(projection, run, "idle", ctx)),
    ...(holdQueue
      ? queued.map((candidate) => runEvent(ctx, "run.updated", { ...candidate, queueHeld: true }))
      : []),
    ...(next === undefined ? [] : startRunEvents(projection, next, "queued_turn", ctx)),
    ...rest.map((candidate, index) =>
      runEvent(ctx, "run.updated", { ...candidate, queuePosition: index + 1 }),
    ),
  ];
}

const userTextOf = (projection: Projection, run: Run) =>
  projection.messages.find((message) => message.id === run.userMessageId)?.text ?? "";

/**
 * One provider step: start the live run, stream its next chunk, or complete
 * it. Empty when nothing is live; a held queue waits for `queue.resume`.
 */
export function scriptedStep(
  projection: Projection,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const run = activeRun(projection);
  if (run === undefined) {
    const next = queuedRuns(projection).find((candidate) => candidate.queueHeld !== true);
    return next === undefined ? [] : startRunEvents(projection, next, "queued_turn", ctx);
  }
  const threadId = projection.thread.id;
  const reply = scriptedReply(userTextOf(projection, run));
  if (run.status === "starting" || run.status === "preparing") {
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
    const running: Run = { ...run, status: "running", startedAt: ctx.now };
    return [
      runEvent(ctx, "run.updated", running),
      ...(attempt === undefined
        ? []
        : [
            attemptEvent(ctx, threadId, "run-attempt.updated", {
              ...attempt,
              status: "running",
              startedAt: ctx.now,
            }),
          ]),
      ...(node === undefined
        ? []
        : [nodeEvent(ctx, { ...node, status: "running", startedAt: ctx.now })]),
      turnItemEvent(
        ctx,
        assistantItem(projection, running, nextScriptedPrefix(reply, 0), "running", ctx),
      ),
    ];
  }
  const shown = assistantItemOf(projection, run)?.text ?? "";
  if (shown.length < reply.length) {
    return [
      turnItemEvent(
        ctx,
        assistantItem(projection, run, nextScriptedPrefix(reply, shown.length), "running", ctx),
      ),
    ];
  }
  return finishRunEvents(projection, run, "completed", ctx);
}

/** Stops the live run where it is. `holdQueue` (the Stop button) also holds queued messages. */
export const interruptRunEvents = (
  projection: Projection,
  run: Run,
  ctx: DecisionContext,
  holdQueue: boolean,
) => finishRunEvents(projection, run, "interrupted", ctx, { holdQueue });

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
