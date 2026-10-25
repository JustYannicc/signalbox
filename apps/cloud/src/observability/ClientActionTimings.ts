import type { ClientActionTimingsBatch } from "@t3tools/contracts/clientActionTiming";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClientTraceExport from "./ClientTraceExport.ts";

const MAX_BUFFERED_SAMPLES = 256;
const MAX_EXPORT_SAMPLES = 128;

export interface ClientActionTimingsEnv {
  readonly T3CODE_TELEMETRY_ENABLED?: string;
  readonly SIGNALBOX_STAGE?: string;
  readonly APP_VERSION?: string;
}

type QueuedSample = {
  readonly userId: string;
  readonly sample: ClientActionTimingsBatch[number];
  readonly receivedAtMs: number;
  readonly hasConsent: () => Effect.Effect<boolean>;
};

export class ClientActionTimings extends Context.Service<
  ClientActionTimings,
  {
    /** Enqueues at most one bounded client batch; export runs under the object lifetime. */
    readonly record: (
      userId: string,
      samples: ClientActionTimingsBatch,
      hasConsent: () => Effect.Effect<boolean>,
    ) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/observability/ClientActionTimings") {}

const toSpan = ({ userId, sample, receivedAtMs }: QueuedSample) => {
  const suffix = sample.correlationId.slice(16);
  const spanId = suffix === "0000000000000000" ? sample.correlationId.slice(0, 16) : suffix;
  const timing = BigInt(receivedAtMs) * 1_000_000n;
  const string = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const measure = (key: string, value: number) => ({ key, value: { doubleValue: value } });
  const attributes = [
    string("person.id", userId),
    string("client.action.id", sample.action),
    string("client.action.entry_point", sample.entryPoint),
    string("client.action.client", sample.client),
    string("client.action.os", sample.os),
    string("client.action.device", sample.device),
    string("client.release", sample.release),
    string("client.action.connection", sample.connection),
    string("client.action.mode", sample.mode),
    string("client.action.path", sample.path),
    measure("client.action.handler_delay_ms", sample.handlerDelayMs),
    string("client.action.outcome", sample.outcome),
    string("client.action.event_timing_status", sample.eventTimingStatus),
  ];
  if (sample.feedback !== null) {
    attributes.push(
      measure("client.action.feedback_ms", sample.feedback.elapsedMs),
      string("client.action.feedback_method", sample.feedback.method),
    );
  }
  if (sample.desiredState !== null) {
    attributes.push(
      measure("client.action.desired_state_ms", sample.desiredState.elapsedMs),
      string("client.action.desired_state_method", sample.desiredState.method),
    );
  }
  if (sample.eventTimingMs !== null)
    attributes.push(measure("client.action.event_timing_ms", sample.eventTimingMs));
  if (sample.eventTimingMethod !== null)
    attributes.push(string("client.action.event_timing_method", sample.eventTimingMethod));
  if (sample.acknowledgementMs !== null)
    attributes.push(measure("client.action.acknowledgement_ms", sample.acknowledgementMs));
  if (sample.convergenceMs !== null)
    attributes.push(measure("client.action.convergence_ms", sample.convergenceMs));
  if (sample.completionMs !== null)
    attributes.push(measure("client.action.completion_ms", sample.completionMs));

  return {
    traceId: sample.correlationId,
    spanId,
    name: "client.action",
    kind: 1,
    startTimeUnixNano: String(timing),
    endTimeUnixNano: String(timing),
    attributes,
  };
};

const clientService = (client: ClientActionTimingsBatch[number]["client"]) =>
  client === "ios" || client === "android"
    ? "t3code-mobile"
    : client === "desktop"
      ? "t3code-desktop"
      : "t3code-web";

const make = (
  exporter: ClientTraceExport.ClientTraceExport["Service"],
  env: ClientActionTimingsEnv,
  waitUntil: (promise: Promise<unknown>) => void,
): ClientActionTimings["Service"] => {
  const pending: Array<QueuedSample> = [];
  let buffered = 0;
  let scheduled = false;
  let running = false;

  const submitBatch = (samples: ReadonlyArray<QueuedSample>) => {
    const byClient = new Map<ClientActionTimingsBatch[number]["client"], Array<QueuedSample>>();
    for (const sample of samples) {
      const group = byClient.get(sample.sample.client) ?? [];
      group.push(sample);
      byClient.set(sample.sample.client, group);
    }
    return exporter.submit({
      resourceSpans: [...byClient].map(([client, group]) => ({
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: clientService(client) } },
            {
              key: "deployment.environment",
              value: { stringValue: env.SIGNALBOX_STAGE ?? "development" },
            },
            { key: "service.version", value: { stringValue: env.APP_VERSION ?? "development" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "signalbox.client.action" },
            spans: group.map(toSpan),
          },
        ],
      })),
    });
  };

  const schedule = () => {
    if (scheduled || running || pending.length === 0) return;
    scheduled = true;
    const task = Promise.resolve().then(async () => {
      scheduled = false;
      if (running || pending.length === 0) return;
      running = true;
      const batch = pending.splice(0, MAX_EXPORT_SAMPLES);
      try {
        const byPerson = new Map<string, Array<QueuedSample>>();
        for (const sample of batch) {
          const group = byPerson.get(sample.userId) ?? [];
          group.push(sample);
          byPerson.set(sample.userId, group);
        }
        for (const group of byPerson.values()) {
          if (env.T3CODE_TELEMETRY_ENABLED?.trim().toLowerCase() === "false") continue;
          const hasConsent = group[0]?.hasConsent;
          if (hasConsent === undefined || !(await Effect.runPromise(hasConsent()))) continue;
          await Effect.runPromise(submitBatch(group));
        }
      } catch {
        // Optional telemetry must not hold a user action open.
      } finally {
        buffered -= batch.length;
        running = false;
        schedule();
      }
    });
    try {
      waitUntil(task);
    } catch {
      // The export can still settle if the runtime cannot retain its promise.
    }
  };

  return {
    record: (userId, samples, hasConsent) =>
      env.T3CODE_TELEMETRY_ENABLED?.trim().toLowerCase() === "false"
        ? Effect.void
        : Clock.currentTimeMillis.pipe(
            Effect.tap((receivedAtMs) =>
              Effect.sync(() => {
                for (const sample of samples) {
                  if (buffered >= MAX_BUFFERED_SAMPLES) break;
                  pending.push({ userId, sample, receivedAtMs, hasConsent });
                  buffered += 1;
                }
                schedule();
              }),
            ),
            Effect.asVoid,
          ),
  };
};

/** TraceExport is the only delivery path; no product analytics or durable queue is involved. */
export const layer = (
  env: ClientActionTimingsEnv,
  waitUntil: (promise: Promise<unknown>) => void,
) =>
  Layer.effect(
    ClientActionTimings,
    Effect.map(ClientTraceExport.ClientTraceExport, (exporter) => make(exporter, env, waitUntil)),
  );

/** The in-memory cloud does not export production traces. */
export const layerOff = Layer.succeed(
  ClientActionTimings,
  ClientActionTimings.of({ record: () => Effect.void }),
);
