import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  providerEventLatencyClock,
  type ProviderEventLatencyTrace,
} from "@t3tools/provider-core/server/ProviderEventLatencyTrace";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";

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

export const CurrentClaudeSdkFrameTrace = Context.Reference<ClaudeSdkFrameTrace | undefined>(
  "@signalbox/provider-claude/ClaudeEventLatencyTrace/CurrentSdkFrameTrace",
  { defaultValue: () => undefined },
);

const sdkFrameTraces = new WeakMap<SDKMessage, ClaudeSdkFrameTrace>();
let nextSdkQueryOrdinal = 0;
let nextProviderOpenOrdinal = 0;
// Native IDs are correlation hints, not an excuse to log unbounded SDK strings.
const MAX_IDENTIFIER_LENGTH = 128;

const record = (value: unknown) => (Predicate.isObject(value) ? value : undefined);

const optionalField = (name: string, value: string | number | undefined) =>
  value === undefined ? {} : { [name]: value };

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
    ...optionalField("nativeSessionId", stringField(message, "session_id")),
    ...optionalField("nativeFrameId", stringField(message, "uuid")),
    ...optionalField("nativeMessageId", stringField(record(sdkEvent)?.message, "id")),
    ...optionalField("parentToolUseId", stringField(message, "parent_tool_use_id")),
    ...optionalField("toolUseId", stringField(message, "tool_use_id")),
    ...optionalField("taskId", stringField(message, "task_id")),
  };
};

export const describeClaudeSdkFrame = (message: SDKMessage) => ({
  sdkType: message.type,
  ...optionalField("sdkSubtype", stringField(message, "subtype")),
  ...sdkMessageIds(message),
});

export function createClaudeSdkStreamId(providerSessionId: string): string {
  return `${providerEventLatencyClock.realmId}/claude-sdk/${providerSessionId}/${++nextSdkQueryOrdinal}`;
}

export const createClaudeProviderEventStreamId = (providerSessionId: string) =>
  `${providerEventLatencyClock.realmId}/claude-provider/${providerSessionId}/${++nextProviderOpenOrdinal}`;

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
}): ProviderEventLatencyTrace {
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
    ...optionalField("entityId", stringField(payload, "id")),
    ...optionalField("nativeId", stringField(nativeRef, "nativeId")),
    ...optionalField("entityOrdinal", numberField(payload, "ordinal")),
    ...(input.sdkFrameTrace === undefined
      ? {}
      : {
          sdkFrameTraceId: input.sdkFrameTrace.traceId,
          sdkFrameOrdinal: input.sdkFrameTrace.streamOrdinal,
        }),
    createdAtMs: providerEventLatencyClock.nowMs(),
  };
}
