import { createRequestLogger, type DrainContext, type DrainFn, type WideEvent } from "evlog";
import type { ObservabilitySink, ObservabilitySinkContext } from "lunorash/runtime";

/** Writes one safe, completed RPC event through the configured evlog drain. */
export const createEvlogObservabilitySink = (drain: DrainFn): ObservabilitySink => ({
  onRpc(event, context) {
    emitEvent(
      drain,
      {
        eventType: "rpc",
        rpc: {
          functionPath: event.functionPath,
          ...(event.shardKey === undefined ? {} : { shardKey: event.shardKey }),
        },
        outcome: event.ok ? "success" : "failure",
        trace: {
          ...(event.traceId === undefined ? {} : { id: event.traceId }),
          ...(event.spanId === undefined ? {} : { spanId: event.spanId }),
          ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
          ...(event.traceFlags === undefined ? {} : { flags: event.traceFlags }),
        },
        ...(!event.ok && event.error !== undefined
          ? { error: { code: event.error.code, status: event.error.status } }
          : {}),
      },
      event.durationMs,
      !event.ok,
      context,
    );
  },

  onSpan(event, context) {
    // The runtime represents dispatch itself via onRpc, so skip a synthetic copy.
    if (event.dispatch === true) return;

    emitEvent(
      drain,
      {
        eventType: "span",
        functionPath: event.functionPath,
        outcome: event.ok ? "success" : "failure",
        span: {
          name: event.name,
          kind: event.kind ?? "internal",
          id: event.spanId,
          parentSpanId: event.parentSpanId,
          traceId: event.traceId,
          status: { code: event.ok ? "ok" : "error" },
          ...(event.sampled === undefined ? {} : { sampled: event.sampled }),
          ...(event.shardKey === undefined ? {} : { shardKey: event.shardKey }),
          ...(event.attributes === undefined ? {} : { attributes: event.attributes }),
          ...(!event.ok && event.error !== undefined ? { errorType: event.error.type } : {}),
        },
      },
      event.durationMs,
      !event.ok,
      context,
    );
  },
});

const emitEvent = (
  drain: DrainFn,
  fields: Record<string, unknown>,
  durationMs: number,
  failed: boolean,
  context?: ObservabilitySinkContext,
): void => {
  // This adapter owns the injected drain; skip evlog's global drain to avoid duplicates.
  const logger = createRequestLogger({}, { _deferDrain: true });
  logger.set(fields);
  if (failed) logger.setLevel("error");

  const emitted = logger.emit({ _durationMs: durationMs });
  if (emitted === null) return;
  drainEvent(drain, emitted, context);
};

const drainEvent = (drain: DrainFn, event: WideEvent, context?: ObservabilitySinkContext): void => {
  const drainPromise = Promise.resolve().then(() => drain({ event } satisfies DrainContext));
  const settled = drainPromise.catch(() => undefined);
  try {
    context?.waitUntil?.(settled);
  } catch {
    // Telemetry cannot affect the RPC that has already completed.
  }
};
