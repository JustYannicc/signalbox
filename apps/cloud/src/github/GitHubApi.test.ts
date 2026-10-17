import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Base64 from "effect/encoding/Base64";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeGitHubApi } from "./GitHubApi.ts";

const responseClient = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
      ),
    ),
  );

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
    expect(error.requestKind).toBe("rest");
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

it.effect("preserves retry time for GitHub's HTTP 200 GraphQL RATE_LIMIT answer", () =>
  Effect.gen(function* () {
    const token = "github-rate-limit-secret-canary";
    const reset = Math.floor((yield* Clock.currentTimeMillis) / 1_000) + 600;
    const client = responseClient(
      {
        data: null,
        errors: [
          {
            type: "RATE_LIMIT",
            message: `API rate limit exceeded: ${token}`,
            extensions: { code: "graphql_rate_limit" },
          },
        ],
      },
      200,
      { "x-ratelimit-reset": String(reset) },
    );

    const error = yield* makeGitHubApi(client)
      .graphql("pullRequestList", token, "query { viewer { login } }", {})
      .pipe(Effect.flip);

    expect(error.operation).toBe("pullRequestList");
    expect(error.status).toBe(200);
    expect(error.retryAt).toBe(reset * 1_000);
    expect(error.requestKind).toBe("graphql");
    expect(error.responseExcerpt).toContain("[redacted]");
    expect(error.responseExcerpt).not.toContain(token);
  }),
);

it.effect(
  "keeps legacy RATE_LIMITED detection and ignores unrelated text containing its name",
  () =>
    Effect.gen(function* () {
      const legacy = yield* makeGitHubApi(
        responseClient({ data: null, errors: [{ type: "RATE_LIMITED", message: "quota" }] }),
      )
        .graphql("legacy", "token", "query { viewer { login } }", {})
        .pipe(Effect.flip);
      expect(legacy.retryAt).toBeDefined();

      const answer = { data: { viewer: null }, message: 'The text "RATE_LIMITED" is a label.' };
      const text = yield* makeGitHubApi(responseClient(answer)).graphql(
        "ordinary",
        "token",
        "query { viewer { login } }",
        {},
      );
      expect(text).toBe(JSON.stringify(answer));
    }),
);
it.effect("keeps bounded, sanitized diagnostics for unreadable GraphQL answers", () => {
  const token = "github-response-secret-canary";
  const lines: Array<string> = [];
  const client = responseClient(
    {
      echo: token,
      data: {
        repository: {
          defaultBranchRef: { name: 17, target: { oid: "abc123" } },
        },
      },
      tail: "x".repeat(500),
    },
    200,
    { "content-type": "application/json; charset=utf-8", "content-length": "843" },
  );

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client)
      .defaultHead(token, "octocat/Hello-World")
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      operation: "defaultHead",
      status: 200,
      requestKind: "graphql",
      message: "GitHub sent an answer Signalbox does not understand.",
      responseContentType: "application/json; charset=utf-8",
      responseContentLength: "843",
    });
    expect(error.responseExcerpt).toContain("defaultBranchRef");
    expect(error.responseExcerpt).toContain("[redacted]");
    expect(error.responseExcerpt).not.toContain(token);
    expect(error.responseExcerpt?.length).toBeLessThanOrEqual(241);

    const logs = lines.join("\n");
    expect(logs).toContain('"requestKind":"graphql"');
    expect(logs).toContain('"status":200');
    expect(logs).toContain("defaultBranchRef");
    expect(logs).toContain('"responseContentType":"application/json; charset=utf-8"');
    expect(logs).toContain('"responseContentLength":"843"');
    expect(logs).not.toContain(token);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect("keeps status and sanitized body diagnostics for failed REST answers", () => {
  const token = "github-rest-secret-canary";
  const lines: Array<string> = [];
  const client = responseClient({ message: `Bearer ${token}` }, 502, {
    "content-type": `application/problem+json; token=${token}; ${"x".repeat(500)}`,
    "content-length": `${token}${"7".repeat(500)}`,
  });

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer(token).pipe(Effect.flip);
    expect(error).toMatchObject({
      operation: "viewer",
      status: 502,
      requestKind: "rest",
    });
    expect(error.message).toBe("Bearer [redacted]");
    expect(error.responseExcerpt).toContain("[redacted]");
    expect(error.responseContentType).toContain("[redacted]");
    expect(error.responseContentType?.length).toBeLessThanOrEqual(121);
    expect(error.responseContentLength).toContain("[redacted]");
    expect(error.responseContentLength?.length).toBeLessThanOrEqual(121);
    const diagnostic = JSON.stringify(error) + lines.join("\n");
    expect(diagnostic).not.toContain(token);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect("omits missing response headers from diagnostics", () => {
  const lines: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          new TextEncoder().encode(JSON.stringify({ message: "not a viewer response" })),
          {
            status: 200,
          },
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer("supplied-token").pipe(Effect.flip);
    expect(error.responseContentType).toBeUndefined();
    expect(error.responseContentLength).toBeUndefined();
    expect(lines.join("\n")).not.toContain("responseContentType");
    expect(lines.join("\n")).not.toContain("responseContentLength");
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect(
  "keeps response headers and rate-limit backoff when the response body cannot be read",
  () => {
    const token = "github-read-failure-secret";
    const lines: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error(token));
              },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/problem+json",
                "content-length": "42",
                "retry-after": "120",
              },
            },
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const api = makeGitHubApi(client);
      for (const read of [
        Effect.asVoid(api.viewer(token)),
        Effect.asVoid(api.rest("viewer", token, "/user")),
      ]) {
        const error = yield* read.pipe(Effect.flip);
        expect(error).toMatchObject({
          operation: "viewer",
          status: 429,
          responseContentType: "application/problem+json",
          responseContentLength: "42",
          retryAt: now + 120_000,
        });
        expect(error.responseExcerpt).toBeUndefined();
        const diagnostic = JSON.stringify(error) + lines.join("\n");
        expect(lines.join("\n")).toContain('"responseContentType":"application/problem+json"');
        expect(lines.join("\n")).toContain('"responseContentLength":"42"');
        expect(diagnostic).not.toContain(token);
      }
    }).pipe(
      Effect.provide(
        Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))]),
      ),
    );
  },
);

it.effect("redacts quoted opaque credentials and the bare git credential", () => {
  const token = "supplied-credential-canary";
  const opaque = "opaque-credential-that-is-not-the-supplied-token";
  const encoded = Base64.encode(`x-access-token:${token}`);
  const lines: Array<string> = [];
  const client = responseClient({ access_token: opaque, refresh_token: opaque, encoded }, 502);

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer(token).pipe(Effect.flip);
    const diagnostic = JSON.stringify(error) + lines.join("\n");
    expect(error.responseExcerpt).toContain("[redacted]");
    expect(diagnostic).not.toContain(opaque);
    expect(diagnostic).not.toContain(encoded);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect("redacts credentials before shortening a whitespace-heavy response", () => {
  const token = "0123456789abcdef0123456789abcdef01234567";
  const lines: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(" ".repeat(713) + token))),
  );

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer(token).pipe(Effect.flip);
    expect(error.responseExcerpt).toBe("[redacted]");
    expect(lines.join("\n")).not.toContain(token.slice(0, 39));
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect("preserves ordinary authentication advice", () => {
  const message = "Basic authentication using a password is not supported.";
  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(responseClient({ message }, 401))
      .viewer("supplied-token")
      .pipe(Effect.flip);
    expect(error.message).toBe(message);
    expect(error.responseExcerpt).toContain(message);
  });
});
