import type { DependencyProgress, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";

import { type DecisionContext, turnItemEvent, unstampedEventId } from "./threadEvents.ts";
import { positionTurnItem, systemNoticeEvents } from "./runner/runnerEvents.ts";

/**
 * What a Runner's drive reports become in a thread's log. A turn's saved
 * files are its checkpoint, so clients show the turn's changed files and
 * diff it the way they do on a self-hosted server; the diff itself is read
 * from the drive (`drive/DriveFiles.ts`), with no machine needed. Notices
 * about the drive (a merge conflict, work that could not land) are system
 * notices in the run's transcript.
 */

type Projection = OrchestrationV2ThreadProjection;
type Run = OrchestrationV2Run;

/**
 * A checkpoint's ref names the turn's commit range, `<start>..<commit>`, as
 * git spells one; an empty start is a turn that began on an empty branch.
 */
const checkpointRange = (start: string | null, commit: string) =>
  CheckpointRef.make(`${start ?? ""}..${commit}`);

export const parseCheckpointRange = (
  ref: string,
): { readonly start: string | null; readonly commit: string } | null => {
  const match = /^([0-9a-f]{40})?\.\.([0-9a-f]{40})$/.exec(ref);
  return match === null ? null : { start: match[1] ?? null, commit: match[2]! };
};

const DRIVE_CWD = "/drive";

export function checkpointEvents(
  projection: Projection,
  run: Run,
  item: Extract<RunnerItem, { readonly kind: "drive.checkpoint" }>,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = projection.thread.id;
  const nodeId = run.rootNodeId;
  // Every harness run has its root node before the Runner reports anything.
  if (nodeId === null) return [];
  const base = {
    id: unstampedEventId,
    threadId,
    runId: run.id,
    nodeId,
    providerInstanceId: run.providerInstanceId,
    occurredAt: ctx.now,
  };
  const scopeId = CheckpointScopeId.make(`checkpoint-scope:${run.id}`);
  const scopeEvents: Array<OrchestrationV2DomainEvent> = projection.checkpointScopes.some(
    (scope) => scope.id === scopeId,
  )
    ? []
    : [
        {
          ...base,
          type: "checkpoint-scope.created",
          payload: {
            id: scopeId,
            threadId,
            runId: run.id,
            nodeId,
            parentScopeId: null,
            providerThreadId: run.providerThreadId,
            kind: "root_run",
            ordinalWithinParent: run.ordinal,
            advancesAppRunCount: true,
            cwd: DRIVE_CWD,
            createdAt: ctx.now,
          },
        },
      ];
  const previous = projection.checkpoints
    .filter(
      (checkpoint) => checkpoint.appRunOrdinal !== null && checkpoint.appRunOrdinal < run.ordinal,
    )
    .toSorted((left, right) => (right.appRunOrdinal ?? 0) - (left.appRunOrdinal ?? 0))[0];
  const checkpoint: OrchestrationV2Checkpoint = {
    id: CheckpointId.make(`checkpoint:${run.id}`),
    threadId,
    scopeId,
    runId: run.id,
    nodeId,
    parentCheckpointId: previous?.id ?? null,
    ordinalWithinScope: 1,
    appRunOrdinal: run.ordinal,
    ref: checkpointRange(item.start, item.commit),
    status: "ready",
    files: item.files,
    capturedAt: ctx.now,
    // What the thread's machine state left out, for its details (#490).
    ...(item.skipped === undefined ? {} : { skipped: item.skipped }),
  };
  const initial: ReadonlyArray<OrchestrationV2DomainEvent> =
    run.ordinal === 1 && !projection.checkpoints.some((saved) => saved.ordinalWithinScope === 0)
      ? [
          {
            ...base,
            type: "checkpoint.captured",
            payload: {
              ...checkpoint,
              id: CheckpointId.make(`checkpoint:${run.id}:start`),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make(
                item.start === null ? "empty" : `${item.start}..${item.start}`,
              ),
              files: [],
            },
          },
        ]
      : [];
  return [
    ...scopeEvents,
    ...initial,
    { ...base, type: "checkpoint.captured", payload: checkpoint },
  ];
}

export function noticeEvents(
  projection: Projection,
  run: Run,
  item: Extract<RunnerItem, { readonly kind: "drive.notice" }>,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const count = projection.turnItems.filter(
    (candidate) =>
      candidate.runId === run.id && candidate.id.startsWith(`turn-item:${run.id}:drive:`),
  ).length;
  return systemNoticeEvents(
    projection,
    run,
    {
      id: TurnItemId.make(`turn-item:${run.id}:drive:${count + 1}`),
      title: "Drive",
      message: item.message,
    },
    ctx,
  );
}

export function dependencyProgressEvents(
  projection: Projection,
  run: Run,
  progress: DependencyProgress,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const id = TurnItemId.make(`turn-item:${run.id}:dependencies:${progress.root}`);
  const previous = projection.turnItems.find((item) => item.id === id);
  if (progress.status === "reused" && previous === undefined) return [];
  const status =
    progress.status === "installing"
      ? "running"
      : progress.status === "failed"
        ? "failed"
        : "completed";
  const common = {
    id,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status,
    title: null,
    startedAt: previous?.startedAt ?? ctx.now,
    completedAt: progress.status === "installing" ? null : ctx.now,
    updatedAt: ctx.now,
  } as const;
  const item: OrchestrationV2TurnItem =
    progress.status === "failed"
      ? {
          ...common,
          status: "failed",
          type: "system_notice",
          message: progress.message,
        }
      : {
          ...common,
          status,
          type: "notification",
          source: { kind: "system" },
          outcome: progress.status === "installing" ? "updated" : "completed",
          summary: progress.message,
          ...(progress.durationMs === undefined
            ? {}
            : { detail: `Setup took ${formatDependencyDuration(progress.durationMs)}.` }),
        };
  return [turnItemEvent(ctx, positionTurnItem(projection, item))];
}

function formatDependencyDuration(durationMs: number) {
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
