import type { AutomationConnectionStatus, AutomationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";

import { listExecutorServices } from "./connections.ts";
import { fail } from "./errors.ts";
import * as ExecutorSettings from "./executorSettings.ts";

export interface AutomationConnectionsShape {
  /** Whether Executor is connected and which accounts it has. Never includes the key. */
  readonly status: Effect.Effect<AutomationConnectionStatus, AutomationError>;
  /** Lists connections with the URL and key first, and saves them only when that works. */
  readonly connect: (input: {
    readonly url: string;
    readonly apiKey: string;
  }) => Effect.Effect<AutomationConnectionStatus, AutomationError>;
  readonly disconnect: Effect.Effect<AutomationConnectionStatus, AutomationError>;
}

/** Settings → Connected services: the Executor connection `w.call` uses. */
export class AutomationConnections extends Context.Service<
  AutomationConnections,
  AutomationConnectionsShape
>()("t3/workflows/connectionSettings/AutomationConnections") {}

const ENV_MANAGED =
  "This server's Executor connection comes from SIGNALBOX_EXECUTOR_URL and SIGNALBOX_EXECUTOR_API_KEY. Change those to switch it.";

/** Accepts `executor.example.com` as well as a full URL; only http(s) origins. */
export function normalizeExecutorUrl(raw: string): string | null {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const store = yield* ExecutorSettings.ExecutorSettingsStore;

  const status = Effect.gen(function* () {
    const settings = yield* store.read;
    if (Option.isNone(settings)) {
      return { configured: false, source: null, url: null, services: [], error: null };
    }
    const { url, source } = settings.value;
    return yield* listExecutorServices(http, settings.value).pipe(
      Effect.map((services) => ({ configured: true, source, url, services, error: null })),
      Effect.catch((error) =>
        Effect.succeed({ configured: true, source, url, services: [], error: error.message }),
      ),
    );
  }).pipe(Effect.withSpan("AutomationConnections.status"));

  const rejectWhenEnvManaged = store.read.pipe(
    Effect.flatMap((settings) =>
      Option.isSome(settings) && settings.value.source === "environment"
        ? fail(ENV_MANAGED)
        : Effect.void,
    ),
  );

  const connect: AutomationConnectionsShape["connect"] = (input) =>
    Effect.gen(function* () {
      yield* rejectWhenEnvManaged;
      const url = normalizeExecutorUrl(input.url);
      if (url === null)
        return yield* fail(`"${input.url}" isn't a web address Executor can be at.`);
      const apiKey = input.apiKey.trim();
      // Listing proves the URL is Executor and the key works before anything is saved.
      const services = yield* listExecutorServices(http, { url, apiKey });
      yield* store.write({ url, apiKey });
      return { configured: true, source: "settings" as const, url, services, error: null };
    }).pipe(Effect.withSpan("AutomationConnections.connect"));

  const disconnect = Effect.gen(function* () {
    yield* rejectWhenEnvManaged;
    yield* store.clear;
    return { configured: false, source: null, url: null, services: [], error: null };
  }).pipe(Effect.withSpan("AutomationConnections.disconnect"));

  return AutomationConnections.of({ status, connect, disconnect });
});

export const layer = Layer.effect(AutomationConnections, make).pipe(
  Layer.provide(ExecutorSettings.layer),
);
