import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  RunId,
  PositiveInt,
  NonNegativeInt,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { finishRunEvents, isLiveRun } from "../runLifecycle.ts";
import {
  attemptEvent,
  type DecisionContext,
  nodeEvent,
  runEvent,
  turnItemEvent,
} from "../threadEvents.ts";

export const PreparationState = Schema.Struct({
  runId: RunId,
  generation: PositiveInt,
  machineGeneration: NonNegativeInt,
  status: Schema.Literals(["preparing", "handoff", "cancelling", "cancelled", "failed", "done"]),
  snapshot: WorktreeSetupSnapshot,
});
export type PreparationState = typeof PreparationState.Type;

export const beginPreparation = (
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
  machineGeneration: number,
  previous: PreparationState | null,
  ctx: DecisionContext,
): PreparationState => {
  const at = DateTime.formatIso(ctx.now);
  const generation = (previous?.generation ?? 0) + 1;
  return {
    runId,
    generation,
    machineGeneration,
    status: "preparing",
    snapshot: {
      threadId: projection.thread.id,
      runId,
      preparationGeneration: generation,
      turnStarted: false,
      cancellationRequested: false,
      phase: "running",
      startedAt: at,
      endedAt: null,
      branch: null,
      baseRef: null,
      worktreePath: null,
      setupScript: null,
      stages: (["fetch", "checkout", "agent"] as const).map((id) => ({
        id,
        status: "pending",
        startedAt: null,
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      })),
      error: null,
      sequence: (previous?.snapshot.sequence ?? 0) + 1,
    },
  };
};

export const changePreparation = (
  state: PreparationState,
  status: PreparationState["status"],
  ctx: DecisionContext,
): PreparationState => {
  const terminal = status === "cancelled" || status === "failed" || status === "done";
  return {
    ...state,
    status,
    snapshot: {
      ...state.snapshot,
      phase: terminal ? status : "running",
      turnStarted: state.snapshot.turnStarted === true || status === "handoff" || status === "done",
      cancellationRequested: status === "cancelling",
      endedAt: terminal ? DateTime.formatIso(ctx.now) : null,
      error:
        status !== "failed"
          ? null
          : state.snapshot.turnStarted === true
            ? "The agent failed to start. Check the thread for details."
            : "Preparing this thread failed. Check the thread for details.",
      sequence: state.snapshot.sequence + 1,
      stages: state.snapshot.stages.map((stage) => ({
        ...stage,
        ...(status === "handoff" && stage.id === "agent"
          ? { status: "running", startedAt: DateTime.formatIso(ctx.now) }
          : status === "handoff" && stage.status === "pending"
            ? { status: "skipped", endedAt: DateTime.formatIso(ctx.now) }
            : terminal && stage.status === "running"
              ? {
                  status:
                    status === "failed" ? "failed" : status === "cancelled" ? "skipped" : "done",
                  endedAt: DateTime.formatIso(ctx.now),
                }
              : {}),
      })),
    },
  };
};

/** Run endings must stop the checkout before another preparation can replace it. */
export const settleStoppedPreparation = (
  state: PreparationState,
  projection: OrchestrationV2ThreadProjection,
  lease: {
    readonly generation: number;
    readonly status: "none" | "requested" | "connected";
  },
  ctx: DecisionContext,
): PreparationState => {
  if (state.status !== "preparing" && state.status !== "cancelling" && state.status !== "handoff")
    return state;
  const run = projection.runs.find((candidate) => candidate.id === state.runId);
  if (run !== undefined && isLiveRun(run)) return state;
  if (state.status === "handoff")
    return changePreparation(state, run?.status === "failed" ? "failed" : "done", ctx);
  const stopped =
    state.machineGeneration === 0 ||
    lease.status === "none" ||
    lease.generation !== state.machineGeneration;
  if (stopped)
    return changePreparation(
      state,
      state.status === "preparing" && run?.status === "failed" ? "failed" : "cancelled",
      ctx,
    );
  return state.status === "cancelling" ? state : changePreparation(state, "cancelling", ctx);
};

/** Only the current attempt may report before handoff. No runner text reaches the snapshot. */
export const preparationItemAllowed = (state: PreparationState | null, item: RunnerItem) => {
  if (state === null || !("runId" in item) || item.runId !== state.runId) return true;
  if ("preparationGeneration" in item && item.preparationGeneration !== undefined) {
    if (item.preparationGeneration !== state.generation) return false;
  } else if (
    item.kind === "turn.started" ||
    item.kind === "turn.failed" ||
    item.kind === "dependencies.progress"
  ) {
    return false;
  }
  if (item.kind === "preparation.cancelled") return state.status === "cancelling";
  if (item.kind === "preparation.failed" && state.status === "cancelling") return true;
  if (state.status === "cancelling" || state.status === "cancelled" || state.status === "failed")
    return false;
  if (item.kind === "turn.started") return state.status === "handoff";
  return true;
};

export const preparationEvents = (
  projection: OrchestrationV2ThreadProjection,
  state: PreparationState,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const run = projection.runs.find((candidate) => candidate.id === state.runId);
  if (run === undefined || !isLiveRun(run)) return [];
  if (state.status === "cancelled" || state.status === "failed") {
    return finishRunEvents(
      projection,
      run,
      state.status === "failed" ? "failed" : "interrupted",
      ctx,
      { queue: "hold" },
    );
  }
  return [];
};

export const retryPreparationEvents = (
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return [];
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
  return [
    runEvent(ctx, "run.updated", { ...run, status: "starting", completedAt: null }),
    ...(attempt === undefined
      ? []
      : [
          attemptEvent(ctx, projection.thread.id, "run-attempt.updated", {
            ...attempt,
            status: "pending",
            completedAt: null,
          }),
        ]),
    ...(node === undefined
      ? []
      : [nodeEvent(ctx, { ...node, status: "pending", completedAt: null })]),
    ...projection.turnItems.flatMap((item) =>
      item.runId === runId && item.type === "error" && item.status === "failed"
        ? [turnItemEvent(ctx, { ...item, status: "cancelled", updatedAt: ctx.now })]
        : [],
    ),
  ];
};
