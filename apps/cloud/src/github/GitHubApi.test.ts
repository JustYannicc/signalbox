import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeGitHubApi } from "./GitHubApi.ts";

it.effect("keeps transport error text and request credentials out of logs", () => {
  const token = "github-transport-secret-canary";
  const detail = `A request carrying ${token} failed`;
  const lines: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause: new Error(detail) }),
      }),
    ),
  );

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer(token).pipe(Effect.flip);
    expect(error.message).toBe("GitHub did not answer.");
    const logs = lines.join("\n");
    expect(logs).toContain("GitHub request failed");
    expect(logs).toContain("viewer");
    expect(logs).toContain("TransportError");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(detail);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect("bounds raw GitHub JSON reads without trusting a missing content-length header", () => {
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(new Uint8Array(8 * 1024 * 1024 + 1))),
    ),
  );
  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client)
      .rest("pullRequestDiff", "token", "/repos/acme/web/compare/base...head")
      .pipe(Effect.flip);
    expect(error.operation).toBe("pullRequestDiff");
    expect(error.message).toContain("size limit");
  });
});

it.effect("preserves missing resources and rate-limit backoff for empty responses", () => {
  const missing = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
  );
  const limited = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      ),
    ),
  );
  return Effect.gen(function* () {
    expect(yield* makeGitHubApi(missing).rest("missing", "token", "/missing")).toBeNull();
    const error = yield* makeGitHubApi(limited)
      .rest("limited", "token", "/limited")
      .pipe(Effect.flip);
    expect(error.status).toBe(429);
    expect(error.retryAt).toBeDefined();
  });
});
