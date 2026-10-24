import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import * as Effect from "effect/Effect";

export interface ProviderEventLatencyTrace {
  readonly traceId: string;
  readonly streamId: string;
  readonly streamOrdinal: number;
  readonly eventType: ProviderAdapterV2Event["type"];
  readonly entityId?: string;
  readonly nativeId?: string;
  readonly entityOrdinal?: number;
  readonly sdkFrameTraceId?: string;
  readonly sdkFrameOrdinal?: number;
  readonly createdAtMs: number;
}

const clockOriginMs = globalThis.performance.timeOrigin;
// @effect-diagnostics cryptoRandomUUID:off - distinguish equal time origins from separate isolates.
const clockRealmId = `performance.now:${clockOriginMs}:${globalThis.crypto.randomUUID()}`;
const traces = new WeakMap<object, ProviderEventLatencyTrace>();

export const providerEventLatencyClock = {
  source: "performance.now",
  realmId: clockRealmId,
  originMs: clockOriginMs,
  nowMs: () => globalThis.performance.now(),
} as const;

export const rememberProviderEventLatencyTrace = (
  event: ProviderAdapterV2Event,
  trace: ProviderEventLatencyTrace,
) => {
  traces.set(event, trace);
};

export const providerEventLatencyTraceFor = (event: ProviderAdapterV2Event) => traces.get(event);

export const logProviderEventLatency = (
  stage: string,
  trace: ProviderEventLatencyTrace,
  fields: Readonly<Record<string, unknown>> = {},
) =>
  Effect.suspend(() =>
    Effect.logDebug("orchestration-v2.provider-event-latency", {
      stage,
      clockSource: providerEventLatencyClock.source,
      clockRealmId: providerEventLatencyClock.realmId,
      clockOriginMs: providerEventLatencyClock.originMs,
      monotonicMs: providerEventLatencyClock.nowMs(),
      ...trace,
      ...fields,
    }),
  );
