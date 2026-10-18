import {
  RetainedWorkflowScript,
  type RunnerItem,
  type WorkflowStopRequest,
} from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2WorkflowStop,
} from "@t3tools/contracts";

import {
  type DecisionContext,
  nodeEvent,
  turnItemEvent,
  providerThreadEvent,
  unstampedEventId,
} from "./threadEvents.ts";
import * as Schema from "effect/Schema";
import type { MachineLease } from "./ThreadStore.ts";

export const workflowEvent = (
  ctx: DecisionContext,
  task: OrchestrationV2Subagent,
): OrchestrationV2DomainEvent => ({
  id: unstampedEventId,
  type: "subagent.updated",
  threadId: task.threadId,
  ...(task.runId === null ? {} : { runId: task.runId }),
  nodeId: task.id,
  occurredAt: ctx.now,
  payload: { ...task, updatedAt: ctx.now },
});

const active = (status: string) => ["idle", "pending", "running", "waiting"].includes(status);

/** Follow descendants downward. A coordinator's parent and siblings can never join this set. */
export function workflowNodes(projection: OrchestrationV2ThreadProjection, id: NodeId) {
  const ids = new Set<NodeId>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of [...projection.nodes, ...projection.subagents]) {
      if (node.parentNodeId !== null && ids.has(node.parentNodeId) && !ids.has(node.id)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function stoppedWorkflowEvents(
  projection: OrchestrationV2ThreadProjection,
  id: NodeId,
  stop: OrchestrationV2WorkflowStop,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const ids = workflowNodes(projection, id);
  const nativeIds = new Set(
    projection.subagents
      .filter((task) => ids.has(task.id))
      .map((task) => task.nativeTaskRef?.nativeId),
  );
  return [
    ...projection.providerThreads
      .filter((thread) =>
        (thread.pendingBackgroundTasks ?? []).some(
          (task) => nativeIds.has(task.taskId) || ids.has(task.taskId as NodeId),
        ),
      )
      .map((thread) =>
        providerThreadEvent(ctx, projection.thread.id, {
          ...thread,
          pendingBackgroundTasks: (thread.pendingBackgroundTasks ?? []).filter(
            (task) => !nativeIds.has(task.taskId) && !ids.has(task.taskId as NodeId),
          ),
        }),
      ),
    ...projection.turnItems
      .filter(
        (item) =>
          active(item.status) &&
          ((item.nodeId !== null && ids.has(item.nodeId)) ||
            (item.type === "subagent" && ids.has(item.subagentId))),
      )
      .map((item) =>
        turnItemEvent(ctx, {
          ...item,
          status: "cancelled",
          completedAt: ctx.now,
          updatedAt: ctx.now,
        }),
      ),
    ...projection.subagents
      .filter((task) => ids.has(task.id))
      .map((task) =>
        workflowEvent(ctx, {
          ...task,
          ...(active(task.status) ? { status: "cancelled", completedAt: ctx.now } : {}),
          ...(task.workflow === undefined
            ? {}
            : {
                workflow: {
                  ...task.workflow,
                  ...(task.id === id ? { stop: { ...stop, status: "stopped" as const } } : {}),
                  agents: task.workflow.agents.map((agent) =>
                    agent.state === "running" || agent.state === "queued"
                      ? { ...agent, state: "failed" as const, result: "Workflow stopped." }
                      : agent,
                  ),
                },
              }),
        }),
      ),
    ...projection.nodes
      .filter((node) => ids.has(node.id) && active(node.status))
      .map((node) => nodeEvent(ctx, { ...node, status: "cancelled", completedAt: ctx.now })),
  ];
}

export const pendingWorkflowStops = (
  projection: OrchestrationV2ThreadProjection,
  generation: number,
): ReadonlyArray<WorkflowStopRequest> =>
  projection.subagents.flatMap((task) => {
    const stop = task.workflow?.stop;
    return stop?.status === "requested" && stop.generation === generation
      ? [
          {
            attempt: stop.attempt ?? 1,
            subagentId: task.id,
            generation,
            runId: stop.runId,
            taskId: stop.taskId,
          },
        ]
      : [];
  });

export function workflowStopResult(
  projection: OrchestrationV2ThreadProjection,
  result: WorkflowStopRequest & { readonly ok: boolean },
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const task = projection.subagents.find((each) => each.id === result.subagentId);
  const stop = task?.workflow?.stop;
  if (
    task === undefined ||
    stop?.status !== "requested" ||
    stop.generation !== result.generation ||
    stop.runId !== result.runId ||
    (stop.attempt ?? 1) !== (result.attempt ?? 1) ||
    stop.taskId !== result.taskId
  )
    return [];
  return result.ok
    ? stoppedWorkflowEvents(projection, task.id, stop, ctx)
    : [
        workflowEvent(ctx, {
          ...task,
          workflow: { ...task.workflow!, stop: { ...stop, status: "failed" } },
        }),
      ];
}

export const lostWorkflowStopEvents = (
  projection: OrchestrationV2ThreadProjection,
  lease: MachineLease,
  ctx: DecisionContext,
) =>
  projection.subagents.flatMap((task) => {
    const stop = task.workflow?.stop;
    return stop?.status === "requested" &&
      (lease.status === "none" || stop.generation !== lease.generation)
      ? stoppedWorkflowEvents(projection, task.id, stop, ctx)
      : [];
  });

/** Only the revision attached to this exact coordinator/run may enter its retained store. */
export const attachedWorkflowScripts = (
  projection: OrchestrationV2ThreadProjection,
  scripts: ReadonlyArray<RetainedWorkflowScript>,
) =>
  scripts.filter((script) =>
    projection.subagents.some(
      (task) =>
        task.id === script.subagentId &&
        task.threadId === projection.thread.id &&
        task.runId === script.runId &&
        task.workflow?.runHandles?.scriptPath === script.scriptPath &&
        task.workflow.runHandles.scriptRevision === script.revision,
    ),
  );

const decodeScript = Schema.decodeUnknownOption(RetainedWorkflowScript);

/** The opaque provider envelope lets an older cloud ignore script retention during a rollout. */
export const workflowScriptsOf = (items: ReadonlyArray<RunnerItem>) =>
  items.flatMap((item) => {
    if (item.kind !== "provider" || item.event.type !== "workflow.script") return [];
    const decoded = decodeScript(item.event);
    return decoded._tag === "Some" && decoded.value.runId === item.runId ? [decoded.value] : [];
  });
