import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { makeGitHubApi } from "./GitHubApi.ts";

const responseClient = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
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
    });
    expect(error.responseExcerpt).toContain("defaultBranchRef");
    expect(error.responseExcerpt).toContain("[redacted]");
    expect(error.responseExcerpt).not.toContain(token);
    expect(error.responseExcerpt?.length).toBeLessThanOrEqual(241);

    const logs = lines.join("\n");
    expect(logs).toContain('"requestKind":"graphql"');
    expect(logs).toContain('"status":200');
    expect(logs).toContain("defaultBranchRef");
    expect(logs).not.toContain(token);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});

it.effect("keeps status and sanitized body diagnostics for failed REST answers", () => {
  const token = "github-rest-secret-canary";
  const lines: Array<string> = [];
  const client = responseClient({ message: `Bearer ${token}` }, 502);

  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client).viewer(token).pipe(Effect.flip);
    expect(error).toMatchObject({
      operation: "viewer",
      status: 502,
      requestKind: "rest",
    });
    expect(error.message).toBe("Bearer [redacted]");
    expect(error.responseExcerpt).toContain("[redacted]");
    expect(error.responseExcerpt).not.toContain(token);
    expect(lines.join("\n")).not.toContain(token);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))])),
  );
});
