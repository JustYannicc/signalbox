import { workflowNodes } from "../workflowControl.ts";
import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { type DecisionContext, turnItemEvent, unstampedEventId } from "../threadEvents.ts";
import { positionTurnItem } from "../turnItemPosition.ts";
export { positionTurnItem, ERROR_ITEM_BAND_POSITION } from "../turnItemPosition.ts";
import { isCloudApprovalRequest, runtimeRequestEvents } from "../runtimeRequests.ts";

/**
 * What a provider adapter's events become in a thread's log, following
 * upstream's ingestor: the same renaming, with turn items placed the way its
 * position store places them. The Runner sends events opaque, so they are
 * checked against the domain event schema here.
 */

/**
 * Adapter event type to the domain event it becomes, and the field holding
 * its payload. Upstream's ingestor does the same renaming; anything else (a
 * subagent's own app thread, an event type added later) is not recorded yet.
 */
const RECORDED = {
  "provider_session.updated": { type: "provider-session.updated", payload: "providerSession" },
  "provider_thread.updated": { type: "provider-thread.updated", payload: "providerThread" },
  "provider_turn.updated": { type: "provider-turn.updated", payload: "providerTurn" },
  "node.updated": { type: "node.updated", payload: "node" },
  "subagent.updated": { type: "subagent.updated", payload: "subagent" },
  "message.updated": { type: "message.updated", payload: "message" },
  "turn_item.updated": { type: "turn-item.updated", payload: "turnItem" },
  "runtime_request.updated": { type: "runtime-request.updated", payload: "runtimeRequest" },
  "plan.updated": { type: "plan.updated", payload: "plan" },
} as const satisfies Record<string, { readonly type: string; readonly payload: string }>;

/** Session and provider-thread state only means something for the run the harness is on. */
const LIVE_RUN_ONLY: ReadonlySet<string> = new Set([
  "provider-session.updated",
  "provider-thread.updated",
]);

export type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const stringField = (record: Json, key: string) =>
  typeof record[key] === "string" ? record[key] : undefined;

const decodeDomainEvent = Schema.decodeUnknownExit(OrchestrationV2DomainEventJson);

/** The thread a payload belongs to, as the adapter names it. */
const payloadThreadId = (event: Json, payload: Json) =>
  stringField(payload, "appThreadId") ??
  stringField(payload, "threadId") ??
  stringField(event, "threadId");

/** A `system_notice` row in `run`'s transcript, after what it already shows. */
export function systemNoticeEvents(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
  notice: { readonly id: TurnItemId; readonly title: string; readonly message: string },
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const item: OrchestrationV2TurnItem = {
    id: notice.id,
    threadId: projection.thread.id,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: notice.title,
    startedAt: ctx.now,
    completedAt: ctx.now,
    updatedAt: ctx.now,
    type: "system_notice",
    message: notice.message,
  };
  return [turnItemEvent(ctx, positionTurnItem(projection, item))];
}

/**
 * One adapter event (anything but `turn.terminal`, which ends a run) as domain
 * events, or none when this thread does not record it. `undecodable` means
 * the event should have been recorded but this build cannot read it (a newer
 * adapter's payload); the turn goes on without it. `liveRunId` is the run the
 * harness is on.
 */
export function recordedEvents(
  projection: OrchestrationV2ThreadProjection,
  item: Extract<RunnerItem, { readonly kind: "provider" }>,
  liveRunId: RunId | undefined,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | "undecodable" {
  const { event } = item;
  const eventType = stringField(event, "type");
  const recorded =
    eventType !== undefined && Object.hasOwn(RECORDED, eventType)
      ? RECORDED[eventType as keyof typeof RECORDED]
      : undefined;
  const payload = recorded === undefined ? undefined : event[recorded.payload];
  if (recorded === undefined || !isRecord(payload)) return [];
  // A run already ended (stopped, or failed for want of a machine) keeps its
  // last transcript rows, but not the harness's view of its session.
  if (LIVE_RUN_ONLY.has(recorded.type) && liveRunId !== item.runId) return [];
  const threadId = projection.thread.id;
  // Subagents' own threads are not served yet; their rows stay on the machine.
  const owner = payloadThreadId(event, payload);
  if (owner !== undefined && owner !== threadId) return [];
  const ownNode = recorded.type === "node.updated" || recorded.type === "subagent.updated";
  const runInstance =
    projection.runs.find((run) => run.id === item.runId)?.providerInstanceId ??
    projection.thread.providerInstanceId;
  // The Runner names the harness's own instance, not the pool's (`runnerTurnFor`).
  // The provider thread is the thread's record: on the run's instance, as
  // `turn.started` keeps it, or the next turn takes it for a provider switch and
  // starts over without the harness's session.
  const recordedPayload =
    recorded.type === "provider-thread.updated" || recorded.type === "subagent.updated"
      ? { ...payload, providerInstanceId: runInstance }
      : payload;
  const decoded = decodeDomainEvent({
    id: unstampedEventId,
    type: recorded.type,
    threadId,
    runId: stringField(payload, "runId") ?? item.runId,
    ...(ownNode
      ? { nodeId: stringField(payload, "id") }
      : stringField(payload, "nodeId") === undefined
        ? {}
        : { nodeId: stringField(payload, "nodeId") }),
    ...(stringField(event, "driver") === undefined ? {} : { driver: stringField(event, "driver") }),
    providerInstanceId: runInstance,
    occurredAt: DateTime.formatIso(ctx.now),
    payload: recordedPayload,
  });
  if (Exit.isFailure(decoded)) return "undecodable";
  let domainEvent = decoded.value;
  if (domainEvent.type === "runtime-request.updated") {
    if (liveRunId !== item.runId) return [];
    return runtimeRequestEvents(projection, domainEvent, ctx);
  }
  if (domainEvent.type === "turn-item.updated") {
    const itemId = domainEvent.payload.id;
    const existing = projection.turnItems.find((item) => item.id === itemId);
    if (existing?.type === "approval_request") {
      const request = projection.runtimeRequests.find(
        (request) => request.id === existing.requestId,
      );
      // Cloud card ownership survives a runner changing the payload's type or request ID.
      if (request !== undefined && isCloudApprovalRequest(projection, request)) return [];
    }
  }
  const requestId =
    domainEvent.type === "node.updated"
      ? domainEvent.payload.runtimeRequestId
      : domainEvent.type === "turn-item.updated" &&
          (domainEvent.payload.type === "approval_request" ||
            domainEvent.payload.type === "user_input_request")
        ? domainEvent.payload.requestId
        : null;
  if (requestId !== null) {
    const request = projection.runtimeRequests.find((request) => request.id === requestId);
    if (
      request !== undefined &&
      (request.status !== "pending" || isCloudApprovalRequest(projection, request))
    )
      return [];
  }
  const stopped = new Set<string>();
  const nativeStopped = new Set<string>();
  for (const coordinator of projection.subagents) {
    if (coordinator.workflow?.stop?.status !== "stopped") continue;
    for (const id of workflowNodes(projection, coordinator.id)) stopped.add(id);
  }
  if (domainEvent.type === "node.updated" || domainEvent.type === "subagent.updated") {
    const payload = domainEvent.payload;
    if (
      stopped.has(payload.id) ||
      (payload.parentNodeId !== null && stopped.has(payload.parentNodeId))
    )
      return [];
  }
  for (const task of projection.subagents) {
    if (stopped.has(task.id) && task.nativeTaskRef?.nativeId)
      nativeStopped.add(task.nativeTaskRef.nativeId);
  }
  if (domainEvent.type === "provider-thread.updated") {
    domainEvent = {
      ...domainEvent,
      payload: {
        ...domainEvent.payload,
        pendingBackgroundTasks: (domainEvent.payload.pendingBackgroundTasks ?? []).filter(
          (task) => !stopped.has(task.taskId) && !nativeStopped.has(task.taskId),
        ),
      },
    };
  }
  if (domainEvent.type === "turn-item.updated") {
    const item = domainEvent.payload;
    if (
      (item.nodeId !== null && stopped.has(item.nodeId)) ||
      (item.type === "subagent" && stopped.has(item.subagentId))
    ) {
      domainEvent = {
        ...domainEvent,
        payload: { ...item, status: "cancelled", completedAt: item.completedAt ?? ctx.now },
      };
    }
  }
  if (domainEvent.type === "subagent.updated") {
    const task = domainEvent.payload;
    const previous = projection.subagents.find((each) => each.id === task.id);
    const { stop: _runnerStop, ...workflow } = task.workflow ?? { phases: [], agents: [] };
    const retained = previous?.workflow?.runHandles;
    domainEvent = {
      ...domainEvent,
      payload: {
        ...task,
        ...(task.workflow === undefined && previous?.workflow === undefined
          ? {}
          : {
              workflow: {
                ...(task.workflow === undefined ? previous!.workflow! : workflow),
                ...(previous?.workflow?.stop === undefined ? {} : { stop: previous.workflow.stop }),
                ...(retained?.scriptRevision === undefined
                  ? {}
                  : {
                      runHandles: {
                        ...task.workflow?.runHandles,
                        scriptPath: retained.scriptPath,
                        scriptRevision: retained.scriptRevision,
                      },
                    }),
              },
            }),
      },
    };
  }
  return domainEvent.type === "turn-item.updated"
    ? [{ ...domainEvent, payload: positionTurnItem(projection, domainEvent.payload) }]
    : [domainEvent];
}
