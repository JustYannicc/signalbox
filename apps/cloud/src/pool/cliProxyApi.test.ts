import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as CliProxyApi from "./cliProxyApi.ts";
import { makeFakeCliProxyApi } from "./testing.ts";

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
      expect(paths).toEqual(["/api/pool-link/v1/models", "/api/pool-link/models"]);
    }),
  );
});
