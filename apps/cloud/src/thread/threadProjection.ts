import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  orchestrationV2RunWorkStartedAt,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

import { isLiveRun } from "./runState.ts";
import type { ThreadMonitor } from "./threadWire.ts";

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

/**
 * When a turn first changed files: the earliest checkpoint with any. A chat
 * that has one started real work (#46). Null: no turn changed a file yet.
 */
export function workStartedAt(projection: OrchestrationV2ThreadProjection): DateTime.Utc | null {
  let earliest: DateTime.Utc | null = null;
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.files.length === 0) continue;
    if (earliest === null || DateTime.isLessThan(checkpoint.capturedAt, earliest)) {
      earliest = checkpoint.capturedAt;
    }
  }
  return earliest;
}

const byOrdinalDesc = (left: OrchestrationV2Run, right: OrchestrationV2Run) =>
  right.ordinal - left.ordinal;

/**
 * The thread's sidebar row. Follows upstream's `threadShellFromProjection` for
 * everything a cloud thread can have. Its background work is `monitors`, the
 * automation runs attached to it, which show and hold it in Working exactly
 * as upstream's monitors do.
 */
export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
  monitors: ReadonlyArray<ThreadMonitor> = [],
): OrchestrationV2ThreadShell {
  const { thread } = projection;
  const runs = projection.runs.toSorted(byOrdinalDesc);
  const latestRun = latestUnheldRun(projection.runs);
  const activeRun = runs.find((run) => isLiveRun(run) && run.status !== "waiting") ?? null;
  const activityRun = runs.find(isLiveRun) ?? null;
  const liveRunIds = new Set(runs.filter(isLiveRun).map((run) => run.id));
  const secretRequests = projection.turnItems.flatMap((item) =>
    item.type === "secret_request" &&
    item.secretStatus === "pending" &&
    item.runId !== null &&
    liveRunIds.has(item.runId)
      ? [
          {
            id: RuntimeRequestId.make(item.id),
            kind: "user_input" as const,
            createdAt: item.startedAt ?? item.updatedAt,
          },
        ]
      : [],
  );
  const pendingRequest = [
    ...projection.runtimeRequests.filter((request) => request.status === "pending"),
    ...secretRequests,
  ].toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
  )[0];
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
    pullRequests: threadPullRequestsOf(thread),
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
    pendingRuntimeRequest:
      pendingRequest === undefined
        ? null
        : {
            id: pendingRequest.id,
            kind: pendingRequest.kind,
            createdAt: pendingRequest.createdAt,
          },
    latestVisibleMessage: null,
    latestUserMessageAt: userMessages[0]?.updatedAt ?? null,
    latestUserAuthoredMessageAt:
      userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [
      ...derivePendingBackgroundWork({
        latestRun,
        providerThreads: [],
        turnItems: [],
        runs: projection.runs,
        monitors: monitors.map((monitor) => ({ ...monitor, kind: "monitor" as const })),
      }),
    ],
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
