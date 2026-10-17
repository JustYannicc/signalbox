import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Base64 from "effect/encoding/Base64";
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

it.effect("reads the whole heads namespace from GitHub refs with the acting token", () => {
  const body = [
    { ref: "refs/heads/main", object: { sha: "a".repeat(40) } },
    { ref: "refs/heads/feature/日本語", object: { sha: "b".repeat(40) } },
  ];
  const requests: Array<string> = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    expect(request.headers.authorization).toBe("Bearer refs-token");
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });
  return Effect.gen(function* () {
    const refs = yield* makeGitHubApi(client).listRefs("refs-token", "owner/repository");
    expect(refs).toEqual(body);
    expect(requests).toEqual([
      "https://api.github.com/repos/owner/repository/git/matching-refs/heads/",
    ]);
  });
});

it.effect("distinguishes an empty heads namespace from inaccessible refs", () =>
  Effect.gen(function* () {
    expect(yield* makeGitHubApi(responseClient([])).listRefs("token", "owner/repository")).toEqual(
      [],
    );
    expect(
      yield* makeGitHubApi(responseClient({}, 404)).listRefs("token", "owner/repository"),
    ).toBe(null);
  }),
);

it.effect("fails unreadable refs instead of silently omitting branches", () =>
  Effect.gen(function* () {
    for (const body of [
      { ref: "refs/heads/main", object: { sha: "a".repeat(40) } },
      [{ ref: "refs/heads/main", object: { sha: 17 } }],
    ]) {
      const error = yield* makeGitHubApi(responseClient(body))
        .listRefs("token", "owner/repository")
        .pipe(Effect.flip);
      expect(error).toMatchObject({ operation: "listRefs", status: 200 });
      expect(error.message).toBe("GitHub sent an answer Signalbox does not understand.");
    }
  }),
);

it.effect("lists no refs for an empty GitHub repository but retains unrelated conflicts", () =>
  Effect.gen(function* () {
    expect(
      yield* makeGitHubApi(responseClient({ message: "Git Repository is empty." }, 409)).listRefs(
        "token",
        "owner/empty",
      ),
    ).toEqual([]);
    const error = yield* makeGitHubApi(responseClient({ message: "A different conflict." }, 409))
      .listRefs("token", "owner/repository")
      .pipe(Effect.flip);
    expect(error.status).toBe(409);
    expect(error.message).toBe("A different conflict.");
  }),
);
