import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeGitHubApi } from "./GitHubApi.ts";
import { makeGitHubHookApi } from "./githubHookApi.ts";

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

const makeTestApi = (respond: (request: SentRequest) => Response) => {
  const requests: Array<SentRequest> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null;
      const sent = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
      };
      requests.push(sent);
      return HttpClientResponse.fromWeb(request, respond(sent));
    }),
  );
  return {
    requests,
    hooks: makeGitHubHookApi(
      makeGitHubApi(client, { web: "https://github.test", api: "https://api.github.test" }),
    ),
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const hook = (id: number, url: string) => ({ id, config: { url } });
const input = {
  url: "https://signalbox.example/hooks/github",
  secret: "hook-secret",
  events: ["push", "pull_request"],
} as const;

describe("GitHub repository hooks", () => {
  it.effect("recovers an uncertain create by finding and updating the exact URL", () =>
    Effect.gen(function* () {
      let storedHook: ReturnType<typeof hook> | null = null;
      let firstCreate = true;
      const { hooks, requests } = makeTestApi((request) => {
        if (request.method === "GET") return json(storedHook === null ? [] : [storedHook]);
        if (request.method === "POST") {
          storedHook = hook(42, input.url);
          if (firstCreate) {
            firstCreate = false;
            return json({ message: "response lost after GitHub created the hook" }, 502);
          }
          return json({ id: 42 });
        }
        if (request.method === "PATCH") return json({ id: 42 });
        throw new Error(`Unexpected ${request.method} ${request.path}`);
      });

      const firstError = yield* Effect.flip(hooks.ensure("token", "acme/app", input));
      expect(firstError.status).toBe(502);
      expect(yield* hooks.ensure("token", "acme/app", input)).toBe(42);
      expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET", "PATCH"]);
      expect(requests[3]?.body).toEqual({
        name: "web",
        active: true,
        events: input.events,
        config: {
          url: input.url,
          content_type: "json",
          secret: input.secret,
          insecure_ssl: "0",
        },
      });
    }),
  );

  it.effect("does not update another hook just because its URL is similar", () =>
    Effect.gen(function* () {
      const { hooks, requests } = makeTestApi((request) => {
        if (request.method === "GET") return json([hook(8, `${input.url}/different`)]);
        if (request.method === "POST") return json({ id: 9 });
        throw new Error(`Unexpected ${request.method} ${request.path}`);
      });

      expect(yield* hooks.ensure("token", "acme/app", input)).toBe(9);
      expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
    }),
  );

  it.effect("continues through full pages before deciding whether to create", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: 100 }, (_, index) =>
        hook(index + 1, `https://other/${index}`),
      );
      const { hooks, requests } = makeTestApi((request) => {
        if (request.method === "GET" && request.query.get("page") === "1") return json(firstPage);
        if (request.method === "GET" && request.query.get("page") === "2")
          return json([hook(101, input.url)]);
        if (request.method === "PATCH") return json({ id: 101 });
        throw new Error(`Unexpected ${request.method} ${request.path}?${request.query}`);
      });

      expect(yield* hooks.ensure("token", "acme/app", input)).toBe(101);
      expect(requests.map(({ query }) => query.get("page"))).toEqual(["1", "2", null]);
      expect(requests.slice(0, 2).map(({ query }) => query.get("per_page"))).toEqual([
        "100",
        "100",
      ]);
      expect(requests[2]?.method).toBe("PATCH");
    }),
  );

  it.effect("fails closed when the hook list exceeds its pagination bound", () =>
    Effect.gen(function* () {
      const fullPage = Array.from({ length: 100 }, (_, index) =>
        hook(index + 1, `https://other/${index}`),
      );
      const { hooks, requests } = makeTestApi((request) => {
        if (request.method === "GET") return json(fullPage);
        throw new Error(`Must not write after an incomplete list: ${request.method}`);
      });

      const error = yield* Effect.flip(hooks.ensure("token", "acme/app", input));
      expect(error.operation).toBe("githubHooks.list");
      expect(error.status).toBe(200);
      expect(requests).toHaveLength(10);
    }),
  );

  it.effect("does not create when GitHub refuses to list repository hooks", () =>
    Effect.gen(function* () {
      const { hooks, requests } = makeTestApi(() => json({ message: "Forbidden" }, 403));

      const error = yield* Effect.flip(hooks.ensure("token", "acme/app", input));
      expect(error.status).toBe(403);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("GET");
    }),
  );

  it.effect("removes hooks idempotently when GitHub already returns 404", () =>
    Effect.gen(function* () {
      const { hooks, requests } = makeTestApi(() => json({ message: "Not Found" }, 404));

      yield* hooks.remove("token", "acme/app", 42);
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.path).toBe("/repos/acme/app/hooks/42");
    }),
  );
});
