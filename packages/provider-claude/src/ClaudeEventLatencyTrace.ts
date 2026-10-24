import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  providerEventLatencyClock,
  providerEventLatencyTraceFor,
  rememberProviderEventLatencyTrace,
  type ProviderEventLatencyTrace,
} from "@t3tools/provider-core/server/ProviderEventLatencyTrace";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const LOG_NAME = "orchestration-v2.claude-event-latency";

export interface ClaudeSdkFrameTrace {
  readonly traceId: string;
  readonly streamId: string;
  readonly streamOrdinal: number;
  readonly sdkType: string;
  readonly sdkSubtype?: string;
  readonly nativeSessionId?: string;
  readonly nativeFrameId?: string;
  readonly nativeMessageId?: string;
  readonly parentToolUseId?: string;
  readonly toolUseId?: string;
  readonly taskId?: string;
  readonly yieldedAtMs: number;
}

export type ClaudeProviderEventTrace = ProviderEventLatencyTrace;

export const CurrentClaudeSdkFrameTrace = Context.Reference<ClaudeSdkFrameTrace | undefined>(
  "@signalbox/provider-claude/ClaudeEventLatencyTrace/CurrentSdkFrameTrace",
  { defaultValue: () => undefined },
);

const sdkFrameTraces = new WeakMap<SDKMessage, ClaudeSdkFrameTrace>();
let nextSdkQueryOrdinal = 0;
// Native IDs are correlation hints, not an excuse to log unbounded SDK strings.
const MAX_IDENTIFIER_LENGTH = 128;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = record(value)?.[key];
  return typeof field === "string" && field.length <= MAX_IDENTIFIER_LENGTH ? field : undefined;
};

const numberField = (value: unknown, key: string): number | undefined => {
  const field = record(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

const sdkMessageIds = (message: SDKMessage) => {
  const sdkEvent = record(message)?.event;
  return {
    ...(stringField(message, "session_id") === undefined
      ? {}
      : { nativeSessionId: stringField(message, "session_id")! }),
    ...(stringField(message, "uuid") === undefined
      ? {}
      : { nativeFrameId: stringField(message, "uuid")! }),
    ...(stringField(record(sdkEvent)?.message, "id") === undefined
      ? {}
      : { nativeMessageId: stringField(record(sdkEvent)?.message, "id")! }),
    ...(stringField(message, "parent_tool_use_id") === undefined
      ? {}
      : { parentToolUseId: stringField(message, "parent_tool_use_id")! }),
    ...(stringField(message, "tool_use_id") === undefined
      ? {}
      : { toolUseId: stringField(message, "tool_use_id")! }),
    ...(stringField(message, "task_id") === undefined
      ? {}
      : { taskId: stringField(message, "task_id")! }),
  };
};

export const describeClaudeSdkFrame = (message: SDKMessage) => ({
  sdkType: message.type,
  ...(stringField(message, "subtype") === undefined
    ? {}
    : { sdkSubtype: stringField(message, "subtype")! }),
  ...sdkMessageIds(message),
});

export function createClaudeSdkStreamId(providerSessionId: string): string {
  return `${providerEventLatencyClock.realmId}/claude-sdk/${providerSessionId}/${++nextSdkQueryOrdinal}`;
}

export const createClaudeProviderEventStreamId = (providerSessionId: string) =>
  `${providerEventLatencyClock.realmId}/claude-provider/${providerSessionId}`;

export function recordClaudeSdkYield(
  message: SDKMessage,
  streamId: string,
  streamOrdinal: number,
): ClaudeSdkFrameTrace {
  const trace: ClaudeSdkFrameTrace = {
    traceId: `${streamId}/frame/${streamOrdinal}`,
    streamId,
    streamOrdinal,
    ...describeClaudeSdkFrame(message),
    yieldedAtMs: providerEventLatencyClock.nowMs(),
  };
  sdkFrameTraces.set(message, trace);
  return trace;
}

export const claudeSdkFrameTraceFor = (message: SDKMessage) => sdkFrameTraces.get(message);

const eventPayload = (event: ProviderAdapterV2Event): unknown => {
  switch (event.type) {
    case "continuation.associated":
      return event.association;
    case "app_thread.created":
      return event.appThread;
    case "provider_session.updated":
      return event.providerSession;
    case "provider_thread.updated":
      return event.providerThread;
    case "provider_turn.updated":
      return event.providerTurn;
    case "node.updated":
      return event.node;
    case "subagent.updated":
      return event.subagent;
    case "message.updated":
      return event.message;
    case "turn_item.updated":
      return event.turnItem;
    case "command_output.delta":
      return { id: event.itemId };
    case "runtime_request.updated":
      return event.runtimeRequest;
    case "plan.updated":
      return event.plan;
    case "turn.terminal":
      return {
        id: event.providerTurnId,
        ordinal: event.runOrdinal,
      };
  }
};

export function makeClaudeProviderEventTrace(input: {
  readonly event: ProviderAdapterV2Event;
  readonly streamId: string;
  readonly streamOrdinal: number;
  readonly sdkFrameTrace?: ClaudeSdkFrameTrace;
}): ClaudeProviderEventTrace {
  const payload = eventPayload(input.event);
  const nativeRef =
    record(payload)?.nativeItemRef ??
    record(payload)?.nativeThreadRef ??
    record(payload)?.nativeTurnRef;
  return {
    traceId: `${input.streamId}/event/${input.streamOrdinal}`,
    streamId: input.streamId,
    streamOrdinal: input.streamOrdinal,
    eventType: input.event.type,
    ...(stringField(payload, "id") === undefined ? {} : { entityId: stringField(payload, "id")! }),
    ...(stringField(nativeRef, "nativeId") === undefined
      ? {}
      : { nativeId: stringField(nativeRef, "nativeId")! }),
    ...(numberField(payload, "ordinal") === undefined
      ? {}
      : { entityOrdinal: numberField(payload, "ordinal")! }),
    ...(input.sdkFrameTrace === undefined
      ? {}
      : {
          sdkFrameTraceId: input.sdkFrameTrace.traceId,
          sdkFrameOrdinal: input.sdkFrameTrace.streamOrdinal,
        }),
    createdAtMs: providerEventLatencyClock.nowMs(),
  };
}

export function rememberClaudeProviderEventTrace(
  event: ProviderAdapterV2Event,
  trace: ClaudeProviderEventTrace,
): void {
  rememberProviderEventLatencyTrace(event, trace);
}

export const claudeProviderEventTraceFor = (event: ProviderAdapterV2Event) =>
  providerEventLatencyTraceFor(event);

export const logClaudeEventLatency = (
  stage: string,
  fields: Readonly<Record<string, unknown>>,
  monotonicMs?: number,
) =>
  Effect.suspend(() =>
    Effect.logDebug(LOG_NAME, {
      stage,
      clockSource: providerEventLatencyClock.source,
      clockRealmId: providerEventLatencyClock.realmId,
      clockOriginMs: providerEventLatencyClock.originMs,
      monotonicMs: monotonicMs ?? providerEventLatencyClock.nowMs(),
      ...fields,
    }),
  );
