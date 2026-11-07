import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CliProxyApi from "./cliProxyApi.ts";
import { makeFakeCliProxyApi } from "./testing.ts";

class ContainerCallFailed extends Schema.TaggedError<ContainerCallFailed>()(
  "ContainerCallFailed",
  {},
) {}

const makeEndpoint = (
  baseUrl: string,
  fetch: (request: Request) => Promise<Response>,
  link = false,
): CliProxyApi.PoolEndpoint => ({
  baseUrl,
  fetch,
  managementKey: "management",
  clientKey: "client",
  link,
});

describe("CLIProxyAPI model discovery", () => {
  it.effect("keeps container transport failures tagged as the backend error cause", () =>
    Effect.gen(function* () {
      const endpoint = CliProxyApi.effectEndpoint(
        {
          baseUrl: "http://cliproxyapi",
          managementKey: "",
          clientKey: "client",
          link: false,
        },
        () => Effect.fail(new ContainerCallFailed()),
      );
      const error = yield* Effect.flip(CliProxyApi.listModels(endpoint));
      expect(error._tag).toBe("PoolBackendError");
      expect(error.cause).toMatchObject({ _tag: "ContainerCallFailed" });
    }),
  );

  it.effect("reads a linked pool's cached catalog without waiting for live model discovery", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const known = [{ id: "claude-model", ownedBy: "anthropic", created: 1 }];
      const endpoint = makeEndpoint(
        "https://app.signalbox.test/api/pool-link",
        async (request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path.endsWith("/models") && !path.endsWith("/v1/models")) {
            return Response.json({ models: known });
          }
          return Response.json({ error: "Live discovery is unavailable" }, { status: 503 });
        },
        true,
      );

      expect(yield* CliProxyApi.listModels(endpoint)).toEqual(known);
      expect(paths).toEqual(["/api/pool-link/models"]);
    }),
  );

  it.effect("discovers served models when a linked catalog has not populated yet", () =>
    Effect.gen(function* () {
      const endpoint = makeEndpoint(
        "https://app.signalbox.test/api/pool-link",
        async (request) =>
          new URL(request.url).pathname.endsWith("/v1/models")
            ? Response.json({ data: [{ id: "claude-model", owned_by: "anthropic", created: 1 }] })
            : Response.json({ models: [] }),
        true,
      );
      expect(yield* CliProxyApi.listModels(endpoint)).toEqual([
        { id: "claude-model", ownedBy: "anthropic", created: 1, provider: "claude" },
      ]);
    }),
  );

  it.effect("reads each provider channel once regardless of its account count", () =>
    Effect.gen(function* () {
      const fake = makeFakeCliProxyApi();
      fake.accounts.set("claude-one.json", {
        type: "claude",
        email: "one@example.test",
        disabled: false,
      });
      fake.accounts.set("claude-two.json", {
        type: "claude",
        email: "two@example.test",
        disabled: false,
      });
      fake.accounts.set("codex-one.json", {
        type: "codex",
        email: "three@example.test",
        disabled: false,
      });

      const models = yield* CliProxyApi.listModels(
        makeEndpoint("https://pool.test", (request) => fake.serve(request)),
      );

      expect(models.some((model) => model.id === "claude-opus-5-5")).toBe(true);
      expect(models.some((model) => model.id === "gpt-6.1-sol")).toBe(true);
      expect(fake.modelDefinitionRequests).toEqual(["claude", "codex"]);
    }),
  );

  it.effect("distinguishes a valid empty link cache from an unavailable route", () =>
    Effect.gen(function* () {
      const empty = yield* CliProxyApi.listPoolLinkModels(
        makeEndpoint("https://app.signalbox.test/api/pool-link", async () =>
          Response.json({ models: [] }),
        ),
      );
      const missing = yield* CliProxyApi.listPoolLinkModels(
        makeEndpoint("https://app.signalbox.test/api/pool-link", async () =>
          Response.json({ error: "not found" }, { status: 404 }),
        ),
      );
      const offline = yield* CliProxyApi.listPoolLinkModels(
        makeEndpoint("https://app.signalbox.test/api/pool-link", async () => {
          throw new Error("offline");
        }),
      );

      expect(empty).toEqual([]);
      expect(missing).toBeNull();
      expect(offline).toBeNull();
    }),
  );

  it.effect("reads definitions once per served channel and keeps model ids when they fail", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const endpoint = makeEndpoint("https://pool.test", async (request) => {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === "/v1/models") {
          return Response.json({
            data: [
              { id: "claude-model", owned_by: "anthropic", created: 1 },
              { id: "codex-model", owned_by: "openai", created: 2 },
              { id: "other-model", owned_by: "unknown", created: 3 },
            ],
          });
        }
        if (path.endsWith("/model-definitions/claude")) {
          return Response.json({
            channel: "claude",
            models: [
              {
                id: "claude-model",
                display_name: "  Claude model  ",
                type: "claude",
                owned_by: "anthropic",
                thinking: { levels: ["low", "  ", "high"] },
              },
            ],
          });
        }
        if (path.endsWith("/model-definitions/codex")) {
          return Response.json({
            channel: "claude",
            models: [
              {
                id: "codex-model",
                display_name: "Wrong channel",
                type: "codex",
                owned_by: "openai",
              },
            ],
          });
        }
        return Response.json({}, { status: 404 });
      });

      const models = yield* CliProxyApi.listModels(endpoint);

      expect(models).toEqual([
        {
          id: "claude-model",
          ownedBy: "anthropic",
          created: 1,
          provider: "claude",
          displayName: "Claude model",
          reasoningEfforts: ["low", "high"],
        },
        { id: "codex-model", ownedBy: "openai", created: 2, provider: "codex" },
        { id: "other-model", ownedBy: "unknown", created: 3 },
      ]);
      expect(paths).toEqual([
        "/v1/models",
        "/v8/management/routing/model-definitions/claude",
        "/v8/management/routing/model-definitions/codex",
      ]);
    }),
  );

  it.effect("keeps ids when an older linked cloud has no cached metadata route", () =>
    Effect.gen(function* () {
      const paths: Array<string> = [];
      const endpoint = makeEndpoint(
        "https://app.signalbox.test/api/pool-link",
        async (request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path.endsWith("/v1/models")) {
            return Response.json({
              data: [{ id: "served-model", owned_by: "anthropic", created: 1 }],
            });
          }
          return Response.json({ error: "not found" }, { status: 404 });
        },
        true,
      );

      const models = yield* CliProxyApi.listModels(endpoint);

      expect(models).toEqual([
        { id: "served-model", ownedBy: "anthropic", created: 1, provider: "claude" },
      ]);
      expect(paths).toEqual(["/api/pool-link/models", "/api/pool-link/v1/models"]);
    }),
  );
});

describe("CLIProxyAPI device login", () => {
  it.effect("requests Codex device mode and preserves its code and expiry", () =>
    Effect.gen(function* () {
      const login = yield* CliProxyApi.startLogin(
        makeEndpoint("https://pool.test", async (request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe("/v8/management/oauth/auth-url");
          expect(url.searchParams.get("provider")).toBe("codex");
          expect(url.searchParams.get("flow")).toBe("device");
          return Response.json({
            url: "https://auth.openai.com/codex/device",
            state: "opaque-state",
            user_code: "TEST-CODE",
            expires_in: 900,
          });
        }),
        "codex",
      );
      expect(login).toMatchObject({
        user_code: "TEST-CODE",
        expires_in: 900,
        state: "opaque-state",
      });
    }),
  );

  it.effect.each([
    { url: "https://login.test/browser", state: "state" },
    {
      url: "https://auth.openai.com/codex/device",
      state: "state",
      user_code: "CODE",
      expires_in: 0,
    },
    {
      url: "https://auth.openai.com/codex/device",
      state: "state",
      user_code: "CODE",
      expires_in: -1,
    },
    { url: "https://auth.openai.com/codex/device", state: "state", user_code: "", expires_in: 900 },
  ])("refuses an unsupported or malformed device response: %j", (body) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        CliProxyApi.startLogin(
          makeEndpoint("https://pool.test", async () => Response.json(body)),
          "codex",
        ),
      );
      expect(error.detail).toContain("Update it to a build with Codex device login support");
    }),
  );

  it.effect("keeps Claude on browser OAuth", () =>
    Effect.gen(function* () {
      const login = yield* CliProxyApi.startLogin(
        makeEndpoint("https://pool.test", async (request) => {
          expect(new URL(request.url).searchParams.has("flow")).toBe(false);
          return Response.json({ url: "https://login.test/claude", state: "state" });
        }),
        "claude",
      );
      expect(login.user_code).toBeUndefined();
    }),
  );
});

describe("CLIProxyAPI Claude manual login", () => {
  it.effect("requests manual mode and requires its exact callback redirect", () =>
    Effect.gen(function* () {
      let requestedFlow: string | null = null;
      const login = yield* CliProxyApi.startLogin(
        makeEndpoint("https://pool.test", async (request) => {
          const url = new URL(request.url);
          requestedFlow = url.searchParams.get("flow");
          const authorization = new URL("https://claude.ai/oauth/authorize");
          authorization.searchParams.set("state", "opaque-state");
          authorization.searchParams.set(
            "redirect_uri",
            "https://platform.claude.com/oauth/code/callback",
          );
          return Response.json({
            url: authorization.toString(),
            state: "opaque-state",
            flow: "manual",
          });
        }),
        "claude",
        "manual",
      );
      expect(requestedFlow).toBe("manual");
      expect(login).toMatchObject({ flow: "manual", state: "opaque-state" });

      for (const response of [
        {
          url: "https://claude.ai/oauth/authorize?state=opaque-state&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback",
          state: "opaque-state",
          flow: "manual",
        },
        { url: "https://claude.ai/oauth/authorize?state=opaque-state", state: "opaque-state" },
      ]) {
        const error = yield* Effect.flip(
          CliProxyApi.startLogin(
            makeEndpoint("https://pool.test", async () => Response.json(response)),
            "claude",
            "manual",
          ),
        );
        expect(error.detail).toContain("Update it to a build with manual Claude code support");
      }

      const unsupported = yield* Effect.flip(
        CliProxyApi.startLogin(
          makeEndpoint("https://pool.test", async () => Response.json({}, { status: 400 })),
          "claude",
          "manual",
        ),
      );
      expect(unsupported.detail).toContain("Update it to a build with manual Claude code support");
    }),
  );

  it.effect(
    "sends code and state separately while keeping loopback callback submission intact",
    () =>
      Effect.gen(function* () {
        const bodies: Array<unknown> = [];
        const endpoint = makeEndpoint("https://pool.test", async (request) => {
          bodies.push(await request.json());
          return Response.json({ status: "ok" });
        });
        yield* CliProxyApi.completeLogin(endpoint, { state: "saved-state", code: "short-code" });
        yield* CliProxyApi.completeLogin(
          endpoint,
          "http://localhost:54545/callback?code=loopback-code&state=loopback-state",
        );
        expect(bodies).toEqual([
          { state: "saved-state", code: "short-code" },
          {
            redirect_url: "http://localhost:54545/callback?code=loopback-code&state=loopback-state",
          },
        ]);
      }),
  );

  it.effect("reports whether the backend actually cancelled a login", () =>
    Effect.gen(function* () {
      const cancelled = yield* CliProxyApi.cancelLogin(
        makeEndpoint("https://pool.test", async () => Response.json({ cancelled: true })),
        "state",
      );
      const saving = yield* CliProxyApi.cancelLogin(
        makeEndpoint("https://pool.test", async () => Response.json({ cancelled: false })),
        "state",
      );
      expect(cancelled).toBe(true);
      expect(saving).toBe(false);
    }),
  );
});
