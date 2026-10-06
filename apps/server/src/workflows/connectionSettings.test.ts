import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import { AutomationConnections, layer, normalizeExecutorUrl } from "./connectionSettings.ts";
import { LIST_CONNECTIONS_CODE, makeConnections } from "./connections.ts";
import * as ExecutorSettings from "./executorSettings.ts";
import { fromJson, toJson } from "./json.ts";

const GOOD_KEY = "exec_live_secret";

/** A fake Executor: the right key lists two Gmail accounts and answers calls; any other key gets 401. */
function fakeExecutor() {
  const requests: Array<{ url: string; authorization: string | undefined; code: string }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const code = (fromJson(body) as { code: string }).code;
        requests.push({ url: request.url, authorization: request.headers.authorization, code });
        const authorized = request.headers.authorization === `Bearer ${GOOD_KEY}`;
        const value =
          code === LIST_CONNECTIONS_CODE
            ? [
                { integration: "gmail", name: "work" },
                { integration: "gmail", name: "home" },
              ]
            : { labels: ["inbox"] };
        return HttpClientResponse.fromWeb(
          request,
          authorized
            ? new Response(
                toJson({
                  status: "completed",
                  structured: { status: "completed", result: { ok: true, value } },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            : new Response(toJson({ text: "Unauthorized" }), { status: 401 }),
        );
      }),
    ),
  );
  return { requests, http };
}

const baseLayer = (http: Layer.Layer<HttpClient.HttpClient>, env: NodeJS.ProcessEnv) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    http,
    ServerConfig.layerTest(import.meta.dirname, { prefix: "signalbox-connections-test-" }),
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcessEnvironment, env)),
  );

function run<A, E>(
  body: Effect.Effect<
    A,
    E,
    | AutomationConnections
    | ExecutorSettings.ExecutorSettingsStore
    | Layer.Success<ReturnType<typeof baseLayer>>
  >,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
) {
  const executor = fakeExecutor();
  const base = baseLayer(executor.http, options.env ?? {});
  // Both sides share one ExecutorSettings store, as they do in the server.
  const services = Layer.mergeAll(layer, ExecutorSettings.layer);
  return { executor, effect: body.pipe(Effect.provide(services.pipe(Layer.provideMerge(base)))) };
}

it.effect(
  "connect verifies the key by listing connections, then saves it out of the settings file",
  () => {
    const { executor, effect } = run(
      Effect.gen(function* () {
        const connections = yield* AutomationConnections;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;

        expect(yield* connections.status).toMatchObject({ configured: false, services: [] });

        const connected = yield* connections.connect({
          url: "executor.example/some/page",
          apiKey: ` ${GOOD_KEY} `,
        });
        expect(connected).toEqual({
          configured: true,
          source: "settings",
          url: "https://executor.example",
          services: [
            { integration: "gmail", name: "home" },
            { integration: "gmail", name: "work" },
          ],
          error: null,
        });

        const status = yield* connections.status;
        expect(status).toEqual(connected);
        expect(toJson(status)).not.toContain(GOOD_KEY);

        const file = yield* fs.readFileString(path.join(config.stateDir, "automations.json"));
        expect(fromJson(file)).toEqual({ executor: { url: "https://executor.example" } });
        expect(file).not.toContain(GOOD_KEY);
        const secretFiles = yield* fs.readDirectory(config.secretsDir);
        expect(secretFiles).toContain("automations-executor-api-key.bin");

        // w.call reads the saved connection.
        const calls = yield* makeConnections;
        expect(
          yield* calls.call({
            operation: "gmail.users.labels.list",
            args: {},
            connection: "work",
            autoApprove: false,
            idempotencyKey: "run_1/s1",
          }),
        ).toEqual({
          labels: ["inbox"],
        });

        expect(yield* connections.disconnect).toMatchObject({ configured: false });
        expect(yield* connections.status).toMatchObject({ configured: false, url: null });
        expect(yield* fs.readDirectory(config.secretsDir)).not.toContain(
          "automations-executor-api-key.bin",
        );
        const failure = yield* Effect.flip(
          calls.call({
            operation: "gmail.users.labels.list",
            args: {},
            autoApprove: false,
            idempotencyKey: "run_1/s1",
          }),
        );
        expect(failure.message).toContain("Settings → Connected services");
      }),
    );
    return effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(executor.requests[0]?.url).toBe("https://executor.example/api/executions");
          expect(executor.requests.every((request) => !request.code.includes(GOOD_KEY))).toBe(true);
        }),
      ),
    );
  },
);

it.effect(
  "a rejected key fails clearly and saves nothing",
  () =>
    run(
      Effect.gen(function* () {
        const connections = yield* AutomationConnections;
        const error = yield* Effect.flip(
          connections.connect({ url: "https://executor.example", apiKey: "wrong" }),
        );
        expect(error.message).toBe("Executor didn't accept the API key.");
        expect(yield* connections.status).toMatchObject({ configured: false });
      }),
    ).effect,
);

it.effect("an address that isn't a web URL is refused before any request", () => {
  const { executor, effect } = run(
    Effect.gen(function* () {
      const connections = yield* AutomationConnections;
      const error = yield* Effect.flip(
        connections.connect({ url: "ftp://executor.example", apiKey: GOOD_KEY }),
      );
      expect(error.message).toContain("isn't a web address");
    }),
  );
  return effect.pipe(Effect.tap(() => Effect.sync(() => expect(executor.requests).toEqual([]))));
});

it.effect(
  "env vars win over settings, and settings can't change them",
  () =>
    run(
      Effect.gen(function* () {
        const connections = yield* AutomationConnections;
        const status = yield* connections.status;
        expect(status).toMatchObject({
          configured: true,
          source: "environment",
          url: "https://env.executor.example",
          services: [
            { integration: "gmail", name: "home" },
            { integration: "gmail", name: "work" },
          ],
        });
        expect(toJson(status)).not.toContain(GOOD_KEY);
        const error = yield* Effect.flip(
          connections.connect({ url: "https://executor.example", apiKey: GOOD_KEY }),
        );
        expect(error.message).toContain("SIGNALBOX_EXECUTOR_URL");
        expect((yield* Effect.flip(connections.disconnect)).message).toContain(
          "SIGNALBOX_EXECUTOR_URL",
        );
      }),
      {
        env: {
          SIGNALBOX_EXECUTOR_URL: "https://env.executor.example",
          SIGNALBOX_EXECUTOR_API_KEY: GOOD_KEY,
        },
      },
    ).effect,
);

it.effect(
  "a key revoked after connecting shows up as a status error",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        // A setup from before Settings, with the key still in the file.
        yield* fs.writeFileString(
          path.join(config.stateDir, "automations.json"),
          toJson({ executor: { url: "https://executor.example", apiKey: "revoked" } }),
        );
        const status = yield* (yield* AutomationConnections).status;
        expect(status).toEqual({
          configured: true,
          source: "settings",
          url: "https://executor.example",
          services: [],
          error: "Executor didn't accept the API key.",
        });
      }),
    ).effect,
);

it("normalizes what people paste as the Executor address", () => {
  expect(normalizeExecutorUrl("https://executor.sh/")).toBe("https://executor.sh");
  expect(normalizeExecutorUrl("http://localhost:4788/app")).toBe("http://localhost:4788");
  expect(normalizeExecutorUrl("executor.sh")).toBe("https://executor.sh");
  expect(normalizeExecutorUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeExecutorUrl("not a url")).toBeNull();
});
