import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  type DecisionContext,
  itemOrdinal,
  turnItemEvent,
  unstampedEventId,
} from "../threadEvents.ts";
import { runtimeRequestEvents } from "../runtimeRequests.ts";

/**
 * What a provider adapter's events become in a thread's log, following
 * upstream's ingestor: the same renaming, with turn items placed the way its
 * position store places them. The Runner sends events opaque, so they are
 * checked against the domain event schema here.
 */

/** Turn items fill a run's band from the bottom; a failure row sits at its top. */
export const ERROR_ITEM_BAND_POSITION = 999_999;

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
export const payloadThreadId = (event: Json, payload: Json) =>
  stringField(payload, "appThreadId") ??
  stringField(payload, "threadId") ??
  stringField(event, "threadId");

// The Runner encodes explicit undefined fields as null; decode with its codec.
const decodeAppThread = Schema.decodeUnknownExit(Schema.toCodecJson(OrchestrationV2AppThread));

/** The provider's native child identity, as emitted before its history rows. */
export function appThreadCreated(
  item: Extract<RunnerItem, { readonly kind: "provider" }>,
): OrchestrationV2AppThread | undefined {
  if (stringField(item.event, "type") !== "app_thread.created") return undefined;
  const value = item.event.appThread;
  if (!isRecord(value)) return undefined;
  const decoded = decodeAppThread(value);
  return Exit.isFailure(decoded) ? undefined : decoded.value;
}

/** The raw ID lets the batch retain a decode failure without retaining metadata. */
export function appThreadCreatedId(
  item: Extract<RunnerItem, { readonly kind: "provider" }>,
): ThreadId | undefined {
  if (stringField(item.event, "type") !== "app_thread.created") return undefined;
  const value = item.event.appThread;
  const id = isRecord(value) ? stringField(value, "id") : undefined;
  return id === undefined ? undefined : (id as ThreadId);
}

/** The explicitly named thread for a supported provider event. */
export function providerEventThreadId(item: Extract<RunnerItem, { readonly kind: "provider" }>) {
  const eventType = stringField(item.event, "type");
  const recorded =
    eventType !== undefined && Object.hasOwn(RECORDED, eventType)
      ? RECORDED[eventType as keyof typeof RECORDED]
      : undefined;
  const payload = recorded === undefined ? undefined : item.event[recorded.payload];
  return isRecord(payload) ? payloadThreadId(item.event, payload) : undefined;
}

/**
 * Turn items are placed in their run's band in the order they first appear,
 * as upstream's position store does, whatever ordinal the adapter chose.
 */
export function positionTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
) {
  const existing = projection.turnItems.find((candidate) => candidate.id === item.id);
  if (existing !== undefined) return { ...item, ordinal: existing.ordinal };
  const run = projection.runs.find((candidate) => candidate.id === item.runId);
  const low = itemOrdinal(run?.ordinal ?? 0, 0);
  const high = itemOrdinal(run?.ordinal ?? 0, ERROR_ITEM_BAND_POSITION - 1);
  const last = projection.turnItems
    .map((candidate) => candidate.ordinal)
    .filter((ordinal) => ordinal >= low && ordinal <= high)
    .reduce((max, ordinal) => Math.max(max, ordinal), low);
  return { ...item, ordinal: last + 1 };
}

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
  options: { readonly nativeChild?: boolean } = {},
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
  // A child row is routed by `runnerBatchEvents`, never recorded on its parent.
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
    recorded.type === "provider-thread.updated"
      ? { ...payload, providerInstanceId: runInstance }
      : payload;
  const payloadRunId = stringField(payload, "runId");
  const decoded = decodeDomainEvent({
    id: unstampedEventId,
    type: recorded.type,
    threadId,
    ...(payloadRunId === undefined && !options.nativeChild
      ? { runId: item.runId }
      : payloadRunId === undefined
        ? {}
        : { runId: payloadRunId }),
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
  const domainEvent = decoded.value;
  if (domainEvent.type === "runtime-request.updated") {
    if (liveRunId !== item.runId) return [];
    return runtimeRequestEvents(projection, domainEvent, ctx);
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
    if (request !== undefined && request.status !== "pending") return [];
  }
  return domainEvent.type === "turn-item.updated"
    ? [{ ...domainEvent, payload: positionTurnItem(projection, domainEvent.payload) }]
    : [domainEvent];
}

/** Provider-native child rows are stored on the child thread with no cloud run id. */
export function recordedNativeChildEvents(
  projection: OrchestrationV2ThreadProjection,
  item: Extract<RunnerItem, { readonly kind: "provider" }>,
  ctx: DecisionContext,
): ReadonlyArray<OrchestrationV2DomainEvent> | "undecodable" {
  return recordedEvents(projection, item, item.runId, ctx, { nativeChild: true });
}
