import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeKernelAuth } from "./KernelAuth.ts";

const connection = (id: string, profile_name = "mine") => ({
  id,
  domain: `${id}.example.com`,
  profile_name,
  status: "NEEDS_AUTH",
  save_credentials: false,
});

it.effect(
  "clears all pages of this profile's auth connections without deleting another profile",
  () =>
    Effect.gen(function* () {
      const asked: Array<string> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const offset = new Map(request.urlParams).get("offset");
          const profile = new Map(request.urlParams).get("profile_name");
          const path = new URL(request.url).pathname;
          asked.push(`${request.method} ${path}${offset === undefined ? "" : `?offset=${offset}`}`);
          const body =
            request.method === "GET"
              ? offset === "0"
                ? Array.from({ length: 100 }, (_, index) => connection(`conn-${index}`))
                : [connection("last"), connection("foreign", "someone-else")]
              : null;
          if (request.method === "GET") expect(profile).toBe("mine");
          return HttpClientResponse.fromWeb(
            request,
            new Response(body === null ? null : JSON.stringify(body), {
              status: request.method === "GET" ? 200 : path.endsWith("last") ? 404 : 204,
            }),
          );
        }),
      );
      yield* makeKernelAuth(client, { apiKey: Redacted.make("sk_test") }).clearConnections("mine");
      expect(asked.slice(0, 2)).toEqual([
        "GET /auth/connections?offset=0",
        "GET /auth/connections?offset=100",
      ]);
      expect(asked.filter((request) => request.startsWith("DELETE"))).toHaveLength(101);
      expect(asked).not.toContain("DELETE /auth/connections/foreign");
    }),
);

it.effect("propagates connection deletion failure so clearing can retry", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(request.method === "GET" ? [connection("one")] : {}), {
            status: request.method === "GET" ? 200 : 503,
          }),
        ),
      ),
    );
    expect(
      yield* Effect.flip(
        makeKernelAuth(client, { apiKey: Redacted.make("sk_test") }).clearConnections("mine"),
      ),
    ).toMatchObject({ operation: "deleteAuthConnection", status: 503 });
  }),
);
