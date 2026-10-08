import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { DiagnosticsStore } from "./DiagnosticsStore.ts";

/**
 * Sends a thread's `cloud.*` usage events (#116) to Signalbox's PostHog
 * project, the same one the self-hosted server's `workload.*` events go to.
 * Events wait in the thread's outbox and the object's alarm sends them, so a
 * failed send or an eviction loses nothing. Each event keeps the uuid it got
 * when queued, so PostHog can tell a resend from a new event.
 *
 * Off without `SIGNALBOX_POSTHOG_KEY`, or with `T3CODE_TELEMETRY_ENABLED=false`
 * (the self-hosted server's switch): then nothing is queued at all. The
 * distinct id is a one-way hash of the thread's owner and person profiles are
 * off, as on the self-hosted server.
 */

export interface CloudAnalyticsEnv {
  readonly SIGNALBOX_POSTHOG_KEY?: string;
  readonly SIGNALBOX_POSTHOG_HOST?: string;
  readonly T3CODE_TELEMETRY_ENABLED?: string;
}

/** Most events per request. */
const BATCH_SIZE = 50;
/** Sends an event is tried before it is dropped, so one bad event cannot block the outbox. */
const MAX_ATTEMPTS = 5;
const DEFAULT_HOST = "https://us.i.posthog.com";
/** What `Config.Boolean` reads as false, as the self-hosted server reads the same switch. */
const TELEMETRY_OFF = new Set(["false", "no", "off", "0", "n"]);

export interface AnalyticsEvent {
  readonly event: string;
  readonly distinctId: string;
  readonly at: number;
  readonly properties: Readonly<Record<string, unknown>>;
}

export class CloudAnalytics extends Context.Service<
  CloudAnalytics,
  {
    /** Queues an event in the thread's outbox. A no-op when analytics are off. */
    readonly enqueue: (event: AnalyticsEvent) => Effect.Effect<void>;
    readonly hasPending: Effect.Effect<boolean>;
    /** Sends one batch. `false` when the send failed and should back off. */
    readonly deliver: Effect.Effect<boolean>;
  }
>()("@signalbox/cloud/thread/diagnostics/CloudAnalytics") {}

export interface AnalyticsSettings {
  readonly key: string;
  readonly host: string;
}

export const settingsFromEnv = (env: CloudAnalyticsEnv): AnalyticsSettings | null => {
  const key = env.SIGNALBOX_POSTHOG_KEY?.trim() ?? "";
  const off = TELEMETRY_OFF.has(env.T3CODE_TELEMETRY_ENABLED?.trim().toLowerCase() ?? "");
  if (key === "" || off) return null;
  const host = env.SIGNALBOX_POSTHOG_HOST?.trim() || DEFAULT_HOST;
  return { key, host: host.replace(/\/+$/, "") };
};

const PropertiesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const encodeProperties = Schema.encodeSync(PropertiesJson);
const decodeProperties = Schema.decodeUnknownSync(PropertiesJson);

/** Analytics off: nothing is queued or sent. */
export const layerOff = Layer.succeed(
  CloudAnalytics,
  CloudAnalytics.of({
    enqueue: () => Effect.void,
    hasPending: Effect.succeed(false),
    deliver: Effect.succeed(true),
  }),
);

/** Sends to the PostHog project `settings` names. */
export const layerOn = (settings: AnalyticsSettings) =>
  Layer.effect(
    CloudAnalytics,
    Effect.gen(function* () {
      const store = yield* DiagnosticsStore;
      const crypto = yield* Crypto.Crypto;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

      const enqueue: CloudAnalytics["Service"]["enqueue"] = (event) =>
        Effect.gen(function* () {
          yield* store.enqueue({
            uuid: yield* Effect.orDie(crypto.randomUUIDv4),
            event: event.event,
            distinctId: event.distinctId,
            at: event.at,
            properties: encodeProperties(event.properties),
          });
        });

      const deliver: CloudAnalytics["Service"]["deliver"] = Effect.gen(function* () {
        const events = yield* store.outbox(BATCH_SIZE);
        if (events.length === 0) return true;
        const ids = events.map((event) => event.id);
        const body = {
          api_key: settings.key,
          batch: events.map((event) => ({
            uuid: event.uuid,
            event: event.event,
            distinct_id: event.distinctId,
            timestamp: DateTime.formatIso(DateTime.makeUnsafe(event.at)),
            properties: {
              ...decodeProperties(event.properties),
              $process_person_profile: false,
              $lib: "signalbox-cloud",
            },
          })),
        };
        const sent = yield* client
          .execute(
            HttpClientRequest.post(`${settings.host}/batch/`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
          )
          .pipe(
            Effect.scoped,
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("cloud analytics send failed", cause).pipe(Effect.as(false)),
            ),
          );
        yield* sent ? store.removeOutbox(ids) : store.failedOutbox(ids, MAX_ATTEMPTS);
        return sent;
      });

      return CloudAnalytics.of({ enqueue, hasPending: store.hasOutbox, deliver });
    }),
  );

export const layerFromEnv = (env: CloudAnalyticsEnv) => {
  const settings = settingsFromEnv(env);
  return settings === null ? layerOff : layerOn(settings);
};
