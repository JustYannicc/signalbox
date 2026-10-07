import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { type DecisionContext, itemOrdinal, unstampedEventId } from "../threadEvents.ts";

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
const payloadThreadId = (event: Json, payload: Json) =>
  stringField(payload, "appThreadId") ??
  stringField(payload, "threadId") ??
  stringField(event, "threadId");

/**
 * Turn items are placed in their run's band in the order they first appear,
 * as upstream's position store does, whatever ordinal the adapter chose.
 */
function positionTurnItem(
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
    providerInstanceId:
      projection.runs.find((run) => run.id === item.runId)?.providerInstanceId ??
      projection.thread.providerInstanceId,
    occurredAt: DateTime.formatIso(ctx.now),
    payload,
  });
  if (Exit.isFailure(decoded)) return "undecodable";
  const domainEvent = decoded.value;
  return domainEvent.type === "turn-item.updated"
    ? [{ ...domainEvent, payload: positionTurnItem(projection, domainEvent.payload) }]
    : [domainEvent];
}
