import {
  CheckpointId,
  CheckpointRef,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { parseCheckpointRange } from "./driveEvents.ts";
import type { RollbackOperation } from "./rollbackState.ts";
import {
  nodeEvent,
  providerThreadEvent,
  runEvent,
  type DecisionContext,
  unstampedEventId,
} from "./threadEvents.ts";

export function rollbackEvents(
  projection: OrchestrationV2ThreadProjection,
  operation: RollbackOperation,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const removed = new Set(
    projection.runs.filter((run) => run.ordinal > operation.targetOrdinal).map((run) => run.id),
  );
  for (const run of projection.runs) {
    if (removed.has(run.id) && run.status !== "rolled_back") {
      events.push(
        runEvent(ctx, "run.updated", { ...run, status: "rolled_back", completedAt: ctx.now }),
      );
    }
  }
  const roots = new Set(
    projection.runs.filter((run) => removed.has(run.id)).map((run) => run.rootNodeId),
  );
  for (const node of projection.nodes) {
    if (roots.has(node.id)) {
      events.push(nodeEvent(ctx, { ...node, status: "rolled_back", completedAt: ctx.now }));
    }
  }
  for (const checkpoint of projection.checkpoints) {
    if (
      checkpoint.ordinalWithinScope !== 0 &&
      checkpoint.id !== operation.checkpointId &&
      checkpoint.runId !== null &&
      removed.has(checkpoint.runId) &&
      checkpoint.status === "ready"
    ) {
      events.push({
        id: unstampedEventId,
        type: "checkpoint.captured",
        threadId: operation.threadId,
        runId: checkpoint.runId,
        nodeId: checkpoint.nodeId,
        occurredAt: ctx.now,
        payload: { ...checkpoint, status: "stale" },
      });
    }
  }
  for (const provider of projection.providerThreads) {
    events.push(
      providerThreadEvent(ctx, operation.threadId, {
        ...provider,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        providerSessionId: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        lastRunOrdinal: operation.targetOrdinal === 0 ? null : operation.targetOrdinal,
        updatedAt: ctx.now,
      }),
    );
  }
  return events;
}

/** Older threads already have the immutable first-turn range, but no baseline row. */
export function baselineEvents(
  projection: OrchestrationV2ThreadProjection,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  if (
    projection.thread.deletedAt !== null ||
    projection.checkpoints.some((item) => item.ordinalWithinScope === 0)
  )
    return [];
  const first = projection.runs.find((run) => run.ordinal === 1);
  const checkpoint = projection.checkpoints.find(
    (item) => item.runId === first?.id && item.appRunOrdinal === 1,
  );
  const range = checkpoint === undefined ? null : parseCheckpointRange(checkpoint.ref);
  if (checkpoint === undefined || range === null) return [];
  return [
    {
      id: unstampedEventId,
      type: "checkpoint.captured",
      threadId: projection.thread.id,
      ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
      nodeId: checkpoint.nodeId,
      occurredAt: ctx.now,
      payload: {
        ...checkpoint,
        id: CheckpointId.make(`checkpoint:${checkpoint.runId}:start`),
        parentCheckpointId: null,
        ordinalWithinScope: 0,
        appRunOrdinal: null,
        ref: CheckpointRef.make(range.start === null ? "empty" : `${range.start}..${range.start}`),
        status: "ready",
        files: [],
      },
    },
  ];
}
