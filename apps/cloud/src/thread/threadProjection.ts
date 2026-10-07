import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  orchestrationV2RunWorkStartedAt,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

import { isLiveRun } from "./scriptedTurn.ts";

/**
 * A cloud thread's read model. Events fold through the same projector every
 * client runs on the events it streams, so the object's snapshot and a
 * client's live view of the same events cannot disagree.
 */

const emptyProjection = (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection => ({
  thread: event.payload,
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: event.occurredAt,
});

/** Folds `events` onto `projection`; a thread starts at its `thread.created`. */
export function applyEvents(
  projection: OrchestrationV2ThreadProjection | null,
  events: Iterable<OrchestrationV2DomainEvent>,
): OrchestrationV2ThreadProjection | null {
  let next = projection;
  for (const event of events) {
    next =
      next === null && event.type === "thread.created"
        ? emptyProjection(event)
        : applyOrchestrationV2ProjectionEvent(next, event);
  }
  return next;
}

const byOrdinalDesc = (left: OrchestrationV2Run, right: OrchestrationV2Run) =>
  right.ordinal - left.ordinal;

/**
 * The thread's sidebar row. Follows upstream's `threadShellFromProjection` for
 * everything a scripted thread can have; runtime requests, pull requests,
 * goals and background work never occur here yet, so they stay empty.
 */
export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const { thread } = projection;
  const runs = projection.runs.toSorted(byOrdinalDesc);
  const latestRun = latestUnheldRun(projection.runs);
  const activeRun = runs.find((run) => isLiveRun(run) && run.status !== "waiting") ?? null;
  const activityRun = runs.find(isLiveRun) ?? null;
  const userMessages = projection.messages
    .filter((message) => message.role === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  return {
    createdBy: thread.createdBy,
    creationSource: thread.creationSource,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: [],
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    activeProviderThreadId: thread.activeProviderThreadId,
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt:
      activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
    status: latestRun?.status ?? "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: userMessages[0]?.updatedAt ?? null,
    latestUserAuthoredMessageAt:
      userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory:
      projection.providerThreads.length > 0 ? [thread.providerInstanceId] : [],
    goal: null,
    itemCount: projection.visibleTurnItems.length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: thread.createdAt,
    updatedAt: projection.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
    pinOrderKey: thread.pinOrderKey ?? null,
    lastVisitedAt: thread.lastVisitedAt,
    titleRegeneration: thread.titleRegeneration ?? null,
    limitRecovery: thread.limitRecovery ?? null,
    deletedAt: thread.deletedAt,
  };
}
