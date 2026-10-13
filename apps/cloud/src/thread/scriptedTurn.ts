import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import { isHarnessInstance } from "./providerCatalog.ts";
import { activeRun, finishRunEvents, nextQueuedRun, startRunEvents } from "./runLifecycle.ts";
import { nextScriptedPrefix, scriptedReply } from "./scriptedProvider.ts";
import {
  attemptEvent,
  type DecisionContext,
  ids,
  itemOrdinal,
  messageEvent,
  nodeEvent,
  runEvent,
  turnItemEvent,
} from "./threadEvents.ts";

/**
 * A run's life on the scripted provider, decided from the projection alone:
 * start, stream one chunk per step, complete, or be interrupted. Every step is
 * a pure function of what the thread's events already say, so replaying a
 * step after a crash either repeats nothing (the step landed) or produces the
 * same events (it did not). Runs on Claude or Codex belong to the Runner.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

const isScripted = (run: Run) => !isHarnessInstance(run.providerInstanceId);

/** Whether a step has anything to do: a scripted run to drive, or a queued run ready to start. */
export const hasPendingTurnWork = (projection: Projection): boolean => {
  const live = activeRun(projection);
  return live === undefined ? nextQueuedRun(projection) !== undefined : isScripted(live);
};

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

const userTextOf = (projection: Projection, run: Run) =>
  projection.messages.find((message) => message.id === run.userMessageId)?.text ?? "";

/** The scripted reply's final transcript rows: the whole reply, or what was shown when stopped. */
function settleAssistant(
  projection: Projection,
  run: Run,
  status: "completed" | "interrupted",
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const current = assistantItemOf(projection, run);
  if (status === "interrupted" && current === undefined) return [];
  const text =
    status === "completed" ? scriptedReply(userTextOf(projection, run)) : (current?.text ?? "");
  return [
    turnItemEvent(ctx, assistantItem(projection, run, text, status, ctx)),
    messageEvent(ctx, {
      createdBy: "agent",
      creationSource: "provider",
      id: ids.assistantMessage(run.id),
      threadId: projection.thread.id,
      runId: run.id,
      nodeId: run.rootNodeId,
      role: "assistant",
      text,
      attachments: [],
      streaming: false,
      createdAt: current?.startedAt ?? ctx.now,
      updatedAt: ctx.now,
    }),
  ];
}

/**
 * One provider step: start the next queued run, or start, stream or complete
 * the live scripted run. Empty when there is nothing to do; a held queue
 * waits for `queue.resume`, and a run on a harness waits for its Runner.
 */
export function scriptedStep(
  projection: Projection,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const run = activeRun(projection);
  if (run === undefined) {
    const next = nextQueuedRun(projection);
    return next === undefined ? [] : startRunEvents(projection, next, "queued_turn", ctx);
  }
  if (!isScripted(run)) return [];
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
  return finishRunEvents(projection, run, "completed", ctx, {
    leading: settleAssistant(projection, run, "completed", ctx),
  });
}

/**
 * Stops the live run where it is. `holdQueue` (the Stop button) also holds
 * queued messages. A Runner's run keeps whatever transcript its harness wrote;
 * the Runner hears about the stop from the thread object.
 */
export const interruptRunEvents = (
  projection: Projection,
  run: Run,
  ctx: DecisionContext,
  holdQueue: boolean,
) =>
  finishRunEvents(projection, run, "interrupted", ctx, {
    queue: holdQueue ? "hold" : "advance",
    leading: isScripted(run) ? settleAssistant(projection, run, "interrupted", ctx) : [],
  });
