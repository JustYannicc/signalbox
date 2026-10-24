import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import * as Effect from "effect/Effect";
import * as LogLevel from "effect/LogLevel";

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
let clockRealmId: string | undefined;
const traces = new WeakMap<object, ProviderEventLatencyTrace>();

export const providerEventLatencyClock = {
  source: "performance.now",
  get realmId() {
    // @effect-diagnostics cryptoRandomUUID:off - Workers require request context for realm entropy.
    return (clockRealmId ??= `performance.now:${clockOriginMs}:${globalThis.crypto.randomUUID()}`);
  },
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
  fields: Readonly<Record<string, unknown>>,
  monotonicMs?: number,
) =>
  Effect.gen(function* () {
    if (!(yield* LogLevel.isEnabled("Debug"))) return;
    yield* Effect.logDebug("orchestration-v2.provider-event-latency", {
      stage,
      clockSource: providerEventLatencyClock.source,
      clockRealmId: providerEventLatencyClock.realmId,
      clockOriginMs: providerEventLatencyClock.originMs,
      monotonicMs: monotonicMs ?? providerEventLatencyClock.nowMs(),
      ...fields,
    });
  });
