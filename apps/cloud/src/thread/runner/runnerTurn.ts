import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderTurnId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { isHarnessInstance } from "../providerCatalog.ts";
import { activeRun, finishRunEvents, providerThreadFor, type RunEnding } from "../runLifecycle.ts";
import {
  attemptEvent,
  type DecisionContext,
  itemOrdinal,
  nodeEvent,
  providerSessionEvent,
  providerThreadEvent,
  runEvent,
  turnItemEvent,
} from "../threadEvents.ts";
import { applyEvents } from "../threadProjection.ts";
import { checkpointEvents, noticeEvents } from "./driveItems.ts";
import {
  ERROR_ITEM_BAND_POSITION,
  type Json,
  recordedEvents,
  stringField,
} from "./runnerEvents.ts";

/**
 * What a Runner's reports mean for a thread, decided from the projection
 * alone: the turn it should run, the events each reported item becomes, and
 * how a run ends when no machine shows up. Pure, like the decider.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

/** The live run a Runner drives, if any. */
export const harnessRun = (projection: Projection): Run | undefined => {
  const run = activeRun(projection);
  return run !== undefined && isHarnessInstance(run.providerInstanceId) ? run : undefined;
};

/**
 * The turn to hand the Runner: the live harness run, until the Runner reports
 * it started. The caller adds its trace id.
 */
export function runnerTurnFor(projection: Projection): Omit<RunnerTurn, "traceId"> | null {
  const run = harnessRun(projection);
  if (run === undefined || (run.status !== "starting" && run.status !== "preparing")) return null;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (
    message === undefined ||
    providerThread === undefined ||
    run.activeAttemptId === null ||
    run.rootNodeId === null
  ) {
    return null;
  }
  // The harness counts turns on its own session; runs that never started never reached it.
  const priorTurns = projection.runs.filter(
    (candidate) =>
      candidate.ordinal < run.ordinal &&
      candidate.providerThreadId === providerThread.id &&
      candidate.startedAt !== null,
  ).length;
  return {
    threadId: projection.thread.id,
    runId: run.id,
    runOrdinal: run.ordinal,
    providerTurnOrdinal: priorTurns + 1,
    attemptId: run.activeAttemptId,
    rootNodeId: run.rootNodeId,
    appThread: projection.thread,
    providerThread,
    message: {
      messageId: message.id,
      text: message.text,
      attachments: message.attachments,
      createdBy: message.createdBy,
      creationSource: message.creationSource,
    },
    modelSelection: run.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
  };
}

/** Ends a live run as failed, with the reason in the transcript. */
export function failRunEvents(
  projection: Projection,
  run: Run,
  failure: OrchestrationV2ProviderFailure,
  ctx: DecisionContext,
  providerTurnId: ProviderTurnId | null = null,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const errorItem: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`turn-item:${run.id}:failure`),
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: itemOrdinal(run.ordinal, ERROR_ITEM_BAND_POSITION),
    status: "failed",
    title: failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: ctx.now,
    completedAt: ctx.now,
    updatedAt: ctx.now,
    type: "error",
    failure,
  };
  return finishRunEvents(projection, run, "failed", ctx, {
    leading: [turnItemEvent(ctx, errorItem)],
  });
}

export const unknownFailure = (message: string): OrchestrationV2ProviderFailure => ({
  class: "unknown",
  message,
  code: null,
  retryable: null,
});

/** `turn.started`: the harness loaded its session, so the run is running. */
function startedEvents(
  projection: Projection,
  run: Run,
  item: Extract<RunnerItem, { readonly kind: "turn.started" }>,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  if (run.status !== "starting" && run.status !== "preparing") return [];
  const threadId = projection.thread.id;
  const current = providerThreadFor(projection, run, "active", ctx);
  // The harness's native state, under the thread's own identity for the record.
  const providerThread = {
    ...item.providerThread,
    id: current.id,
    driver: item.providerSession.driver,
    providerInstanceId: run.providerInstanceId,
    providerSessionId: item.providerSession.id,
    appThreadId: threadId,
    ownerNodeId: current.ownerNodeId,
    firstRunOrdinal: current.firstRunOrdinal,
    lastRunOrdinal: run.ordinal,
    handoffIds: current.handoffIds,
    forkedFrom: current.forkedFrom,
    status: "active" as const,
    createdAt: current.createdAt,
    updatedAt: ctx.now,
  };
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  return [
    providerSessionEvent(ctx, threadId, item.providerSession),
    providerThreadEvent(ctx, threadId, providerThread),
    runEvent(ctx, "run.updated", { ...run, status: "running", startedAt: ctx.now }),
    ...(attempt === undefined
      ? []
      : [
          attemptEvent(ctx, threadId, "run-attempt.updated", {
            ...attempt,
            ...(nativeThreadId == null ? {} : { nativeThreadId }),
            status: "running",
            startedAt: ctx.now,
          }),
        ]),
    ...(node === undefined
      ? []
      : [nodeEvent(ctx, { ...node, status: "running", startedAt: ctx.now })]),
  ];
}

const TERMINAL_ENDINGS: Readonly<Record<string, RunEnding>> = {
  completed: "completed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  failed: "failed",
};

/** `turn.terminal`: the harness finished the run's turn. Ignored once the run already ended. */
function terminalEvents(
  projection: Projection,
  event: Json,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const run = projection.runs.find((candidate) => candidate.ordinal === event.runOrdinal);
  const reported = stringField(event, "status");
  const status =
    reported !== undefined && Object.hasOwn(TERMINAL_ENDINGS, reported)
      ? TERMINAL_ENDINGS[reported]
      : undefined;
  if (run === undefined || status === undefined || run.id !== harnessRun(projection)?.id) {
    return [];
  }
  if (status !== "failed") return finishRunEvents(projection, run, status, ctx);
  const failure = decodeFailure(event.failure);
  return failRunEvents(
    projection,
    run,
    Exit.isSuccess(failure) ? failure.value : unknownFailure("The provider turn failed."),
    ctx,
    (stringField(event, "providerTurnId") as ProviderTurnId | undefined) ?? null,
  );
}

const decodeFailure = Schema.decodeUnknownExit(Schema.toCodecJson(OrchestrationV2ProviderFailure));

/** The events one reported item becomes. */
function itemEvents(
  projection: Projection,
  item: RunnerItem,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | "undecodable" {
  const run = harnessRun(projection);
  // Usage and log lines are for the turn's diagnostics, not its events.
  if (item.kind === "usage" || item.kind === "log") return [];
  if (item.kind === "provider") {
    return stringField(item.event, "type") === "turn.terminal"
      ? terminalEvents(projection, item.event, ctx)
      : recordedEvents(projection, item, run?.id, ctx);
  }
  // A report about a run that already ended (stopped, or failed for want of a machine).
  if (run === undefined || run.id !== item.runId) return [];
  switch (item.kind) {
    case "turn.started":
      return startedEvents(projection, run, item, ctx);
    case "turn.failed":
      return failRunEvents(projection, run, unknownFailure(item.message), ctx);
    case "drive.checkpoint":
      return checkpointEvents(projection, run, item, ctx);
    case "drive.notice":
      return noticeEvents(projection, run, item, ctx);
  }
}

/**
 * A batch's events, each item decided against the projection the earlier ones
 * left, and the adapter event types it could not read.
 */
export function runnerBatchEvents(
  projection: Projection,
  items: ReadonlyArray<RunnerItem>,
  ctx: DecisionContext,
): {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly undecodable: ReadonlyArray<string>;
} {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const undecodable: Array<string> = [];
  let current = projection;
  for (const item of items) {
    const next = itemEvents(current, item, ctx);
    if (next === "undecodable") {
      undecodable.push(item.kind === "provider" ? String(item.event.type) : item.kind);
      continue;
    }
    if (next.length === 0) continue;
    events.push(...next);
    current = applyEvents(current, next) ?? current;
  }
  return { events, undecodable };
}
