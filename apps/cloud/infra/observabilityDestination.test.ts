import { describe, expect, it } from "@effect/vitest";
import { Stack, Stage } from "alchemy";
import { CloudflareEnvironment, Credentials } from "alchemy/Cloudflare";
import {
  ObservabilityDestination,
  ObservabilityDestinationProvider,
} from "alchemy/Cloudflare/Workers";
import * as Provider from "alchemy/Provider";
import { noopSession } from "alchemy/Report";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

const accountId = "00000000000000000000000000000001";
const name = "signalbox-preview-sentry-traces";
const url = "https://collector.example.test/v1/traces";
const props = { name, url, enabled: false, logpushDataset: "opentelemetry-traces" } as const;
const target = {
  slug: name,
  accountId,
  name,
  enabled: false,
  url,
  logpushDataset: "opentelemetry-traces" as const,
  destinationConf: "fixture",
  scripts: [],
};

const destination = (destinationName: string) => ({
  slug: destinationName,
  name: destinationName,
  enabled: false,
  scripts: [],
  configuration: {
    type: "logpush",
    url,
    logpushDataset: "opentelemetry-traces",
    destination_conf: "fixture",
    headers: { "content-type": "application/json" },
    jobStatus: { last_complete: "", last_error: "", error_message: "" },
  },
});

const fixture = () => {
  const requests: Array<{ method: string; page: number }> = [];
  const destinations = [
    ...Array.from({ length: 50 }, (_, index) => destination(`newer-${index}`)),
    destination(name),
  ];
  const client = HttpClient.make((request, requestUrl) =>
    Effect.sync(() => {
      const page = Number(requestUrl.searchParams.get("page") ?? 1);
      const perPage = Number(requestUrl.searchParams.get("perPage") ?? 20);
      requests.push({ method: request.method, page });
      const result = destinations.slice((page - 1) * perPage, page * perPage);
      const body =
        request.method === "GET"
          ? { success: true, errors: [], messages: [], result }
          : {
              success: false,
              errors: [{ message: "Bad Request", detail: "destination already exists" }],
              messages: [],
            };
      return HttpClientResponse.fromWeb(
        request,
        Response.json(body, {
          status: request.method === "GET" ? 200 : 400,
        }),
      );
    }),
  );
  const apiToken = Redacted.make("fixture-token");
  const services = Layer.mergeAll(
    Layer.succeed(Stage, "fixture"),
    Layer.succeed(Stack, {
      name: "fixture",
      stage: "fixture",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        type: "apiToken",
        apiToken,
        apiBaseUrl: "https://api.example.test/client/v4",
      }),
    ),
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken,
        accountId,
        source: { type: "env" },
      }),
    ),
  );
  return {
    requests,
    provider: ObservabilityDestinationProvider().pipe(Layer.provideMerge(services)),
  };
};

const resource = { id: "SentryTraces", fqn: "SentryTraces", instanceId: "fixture" };

class ProviderFailure extends Data.TaggedError("ProviderFailure")<{ cause: unknown }> {}

const providerFailure = (cause: unknown) => new ProviderFailure({ cause });

describe("Alchemy observability destinations beyond the first API page", () => {
  it.effect("refreshes an existing destination by slug without losing it", () => {
    const { requests, provider } = fixture();
    return Effect.gen(function* () {
      const service = yield* Provider.findProvider(ObservabilityDestination);
      if (!service.read) throw new Error("read provider missing");
      const read: Effect.Effect<
        ObservabilityDestination["Attributes"] | undefined,
        ProviderFailure
      > = Effect.mapError(
        service.read({ ...resource, olds: props, output: target }),
        providerFailure,
      );
      const observed = yield* read;
      expect(observed).toEqual(target);
      expect(requests.some((request) => request.page > 1)).toBe(true);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }).pipe(Effect.provide(provider));
  });

  it.effect("reconciles by name without attempting a duplicate create", () => {
    const { requests, provider } = fixture();
    return Effect.gen(function* () {
      const service = yield* Provider.findProvider(ObservabilityDestination);
      const reconcile: Effect.Effect<ObservabilityDestination["Attributes"], ProviderFailure> =
        Effect.mapError(
          service.reconcile({
            ...resource,
            news: props,
            olds: undefined,
            output: undefined,
            bindings: [],
            session: { ...noopSession, note: () => Effect.void },
          }),
          providerFailure,
        );
      const observed = yield* reconcile;
      expect(observed).toEqual(target);
      expect(requests.some((request) => request.page > 1)).toBe(true);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }).pipe(Effect.provide(provider));
  });

  it.effect("lists every destination and terminates without pagination metadata", () => {
    const { requests, provider } = fixture();
    return Effect.gen(function* () {
      const service = yield* Provider.findProvider(ObservabilityDestination);
      if (!service.list) throw new Error("list provider missing");
      const list: Effect.Effect<ObservabilityDestination["Attributes"][], ProviderFailure> =
        Effect.mapError(service.list(), providerFailure);
      const observed = yield* list;
      expect(observed).toHaveLength(51);
      expect(observed.at(-1)).toEqual(target);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    }).pipe(Effect.provide(provider));
  });
});
