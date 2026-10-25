import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  ClientActionTiming as ClientActionTimingContract,
  ClientActionTimingsBatch,
} from "@t3tools/contracts/clientActionTiming";

import * as ClientTraceExport from "./ClientTraceExport.ts";
import * as ClientActionTimings from "./ClientActionTimings.ts";

const PERSON = "user_01HZY3K5Q8W2N4M6P7R9T0V1XA";
const sample = {
  action: "thread.send",
  entryPoint: "click",
  client: "web",
  os: "linux",
  device: "computer",
  release: "1.2.3",
  connection: "online",
  mode: "cloud",
  path: "optimistic",
  inputTimeMs: 12.5,
  handlerDelayMs: 1.5,
  feedback: { elapsedMs: 22, method: "browser_frame_estimate" },
  desiredState: { elapsedMs: 35, method: "commit_only" },
  eventTimingMs: 18,
  eventTimingMethod: "browser_event_timing",
  eventTimingStatus: "observed",
  acknowledgementMs: 120,
  convergenceMs: null,
  completionMs: null,
  outcome: "success",
  correlationId: "1234567890abcdef1234567890abcdef",
} satisfies ClientActionTimingContract;

const baseEnv: Pick<
  ClientTraceExport.TraceExportEnv,
  "TRACE_EXPORT" | "TRACE_EXPORT_TOKEN" | "T3CODE_TELEMETRY_ENABLED"
> = {
  TRACE_EXPORT_TOKEN: "test-token",
};

const program = (
  samples: ClientActionTimingsBatch,
  hasConsent: () => Effect.Effect<boolean> = () => Effect.succeed(true),
) =>
  Effect.gen(function* () {
    const timings = yield* ClientActionTimings.ClientActionTimings;
    yield* timings.record(PERSON, samples, hasConsent);
  });

const layer = (env: ClientTraceExport.TraceExportEnv, pending: Array<Promise<unknown>>) =>
  ClientActionTimings.layer(env, (promise) => pending.push(promise)).pipe(
    Layer.provideMerge(ClientTraceExport.layer(env)),
  );

const drain = (pending: ReadonlyArray<Promise<unknown>>) =>
  Effect.promise(async () => Promise.all(pending));

describe("ClientActionTimings", () => {
  it.effect("exports content-free bounded spans through the existing trace binding", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
      const pending: Array<Promise<unknown>> = [];
      const env: ClientTraceExport.TraceExportEnv = {
        ...baseEnv,
        APP_VERSION: "9.8.7",
        SIGNALBOX_STAGE: "production",
        TRACE_EXPORT: {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            requests.push({ url: request.url, body: JSON.parse(await request.text()) });
            return new Response(null, { status: 200 });
          },
        },
      };
      const privateText = "private-setting-value";
      const unsafeSample = {
        ...sample,
        hiddenSettingValue: privateText,
      } as unknown as ClientActionTimingContract;
      yield* program([
        unsafeSample,
        {
          ...sample,
          client: "ios",
          os: "ios",
          device: "phone",
          correlationId: "abcdef1234567890abcdef1234567890",
        },
      ]).pipe(Effect.provide(layer(env, pending)));
      yield* drain(pending);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://trace-export/v1/traces");
      const body = requests[0]?.body as {
        readonly resourceSpans: ReadonlyArray<{
          readonly resource: Record<string, unknown>;
          readonly scopeSpans: ReadonlyArray<{
            readonly spans: ReadonlyArray<Record<string, unknown>>;
          }>;
        }>;
      };
      const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
      expect(body.resourceSpans).toHaveLength(2);
      expect(spans).toHaveLength(1);
      expect(body.resourceSpans[1]?.resource).toMatchObject({
        attributes: expect.arrayContaining([
          { key: "service.name", value: { stringValue: "t3code-mobile" } },
        ]),
      });
      expect(spans[0]).toMatchObject({
        traceId: sample.correlationId,
        name: "client.action",
        attributes: expect.arrayContaining([
          { key: "person.id", value: { stringValue: PERSON } },
          { key: "client.action.id", value: { stringValue: "thread.send" } },
          { key: "client.action.feedback_ms", value: { doubleValue: 22 } },
          { key: "client.action.desired_state_method", value: { stringValue: "commit_only" } },
        ]),
      });
      expect(spans[0]?.attributes).not.toContainEqual(
        expect.objectContaining({ key: "client.action.correlation_id" }),
      );
      expect(JSON.stringify(body)).not.toContain(privateText);
      expect(JSON.stringify(body)).not.toContain("client.action.input_time_ms");
      expect(requests.map((request) => request.url)).toEqual(["https://trace-export/v1/traces"]);
    }),
  );

  it.effect("drops queued batches when persisted consent is turned off before export", () =>
    Effect.gen(function* () {
      let requests = 0;
      let releaseConsent!: () => void;
      let started!: () => void;
      const consentStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const consentGate = new Promise<void>((resolve) => {
        releaseConsent = resolve;
      });
      let enabled = true;
      const hasConsent = () =>
        Effect.promise(async () => {
          started();
          await consentGate;
          return enabled;
        });
      const pending: Array<Promise<unknown>> = [];
      const env: ClientTraceExport.TraceExportEnv = {
        ...baseEnv,
        TRACE_EXPORT: {
          fetch: async () => {
            requests += 1;
            return new Response(null, { status: 200 });
          },
        },
      };
      yield* program([sample], hasConsent).pipe(Effect.provide(layer(env, pending)));
      yield* Effect.promise(() => consentStarted);
      enabled = false;
      releaseConsent();
      yield* drain(pending);
      expect(requests).toBe(0);
    }),
  );

  it.effect("drops batches when the server telemetry switch is false, case-insensitively", () =>
    Effect.gen(function* () {
      let requests = 0;
      const pending: Array<Promise<unknown>> = [];
      const env: ClientTraceExport.TraceExportEnv = {
        ...baseEnv,
        T3CODE_TELEMETRY_ENABLED: "FALSE",
        TRACE_EXPORT: {
          fetch: async () => {
            requests += 1;
            return new Response(null, { status: 200 });
          },
        },
      };
      yield* program([sample]).pipe(Effect.provide(layer(env, pending)));
      yield* drain(pending);
      expect(requests).toBe(0);
    }),
  );

  it.effect("swallows exporter failures so a batch cannot fail its action RPC", () =>
    Effect.gen(function* () {
      const pending: Array<Promise<unknown>> = [];
      const env: ClientTraceExport.TraceExportEnv = {
        ...baseEnv,
        TRACE_EXPORT: { fetch: async () => new Response(null, { status: 502 }) },
      };
      yield* program([sample]).pipe(Effect.provide(layer(env, pending)));
      yield* drain(pending);
      expect(pending).toHaveLength(1);
    }),
  );
});
