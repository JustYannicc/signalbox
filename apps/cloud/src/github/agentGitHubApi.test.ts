import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { makeAgentGitHubApi } from "./agentGitHubApi.ts";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Uint8Array | null;
  readonly bodyLength: number | undefined;
}

const fakeClient = (answer: (request: SeenRequest) => Response) => {
  const requests: Array<SeenRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body = request.body._tag === "Uint8Array" ? request.body.body : null;
      const url = Option.getOrElse(HttpClientRequest.toUrl(request), () => new URL(request.url));
      const seen: SeenRequest = {
        method: request.method,
        url: url.toString(),
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers["content-type"],
        body: body === null ? null : new Uint8Array(body),
        bodyLength: request.body._tag === "Uint8Array" ? request.body.contentLength : undefined,
      };
      requests.push(seen);
      return HttpClientResponse.fromWeb(request, answer(seen));
    }),
  );
  return { client, requests };
};

const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, { status, ...(headers === undefined ? {} : { headers }) });

const endpoints = {
  web: "https://github.com",
  api: "https://api.github.test",
  uploads: "https://uploads.github.test",
};

describe("agent GitHub API", () => {
  it.effect("reads PRs with the complete head repository field", () => {
    const { client, requests } = fakeClient(() =>
      json({ number: 7, head: { repo: { full_name: "fork/login" } } }),
    );
    const api = makeAgentGitHubApi(client, endpoints);

    return Effect.gen(function* () {
      const text = yield* api.agentPull("gho_test", "owner/repo", 7);
      expect(JSON.parse(text ?? "")).toEqual({
        number: 7,
        head: { repo: { full_name: "fork/login" } },
      });
      expect(requests).toMatchObject([
        {
          method: "GET",
          url: "https://api.github.test/repos/owner/repo/pulls/7",
          authorization: "Bearer gho_test",
          accept: "application/vnd.github+json",
        },
      ]);
    });
  });

  it.effect("combines all three comment lists and fetches the next full page", () => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const { client, requests } = fakeClient(({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/issues/7/comments")) {
        return json(parsed.searchParams.get("page") === "1" ? firstPage : [{ id: 100 }]);
      }
      if (parsed.pathname.endsWith("/pulls/7/comments")) return json([{ id: "review-comment" }]);
      return json([{ id: "review" }]);
    });
    const api = makeAgentGitHubApi(client, endpoints);

    return Effect.gen(function* () {
      const text = yield* api.agentComments("gho_test", "owner/repo", 7);
      expect(JSON.parse(text ?? "")).toEqual({
        issueComments: [...firstPage, { id: 100 }],
        reviewComments: [{ id: "review-comment" }],
        reviews: [{ id: "review" }],
      });
      const issuePages = requests
        .map((request) => new URL(request.url))
        .filter((url) => url.pathname.endsWith("/issues/7/comments"))
        .map((url) => url.searchParams.get("page"));
      expect(issuePages).toEqual(["1", "2"]);
      expect(requests).toHaveLength(4);
    });
  });

  it.effect("fails rather than returning a truncated comment list at the page bound", () => {
    const fullPage = Array.from({ length: 100 }, (_, id) => ({ id }));
    const { client, requests } = fakeClient(({ url }) =>
      new URL(url).pathname.endsWith("/issues/7/comments") ? json(fullPage) : json([]),
    );
    const api = makeAgentGitHubApi(client, endpoints);

    return Effect.gen(function* () {
      const error = yield* api.agentComments("gho_test", "owner/repo", 7).pipe(Effect.flip);
      expect(error.message).toBe("GitHub returned more pages than Signalbox can read completely.");
      expect(requests.filter((request) => request.url.includes("/issues/7/comments"))).toHaveLength(
        10,
      );
    });
  });

  it.effect("edits a PR, comments, and replies through fixed REST routes", () => {
    const { client, requests } = fakeClient(() => json({ ok: true }));
    const api = makeAgentGitHubApi(client, endpoints);

    return Effect.gen(function* () {
      yield* api.agentEdit("gho_test", "owner/repo", 7, "new PR body");
      yield* api.agentComment("gho_test", "owner/repo", 7, "general comment");
      yield* api.agentReply("gho_test", "owner/repo", 7, "44", "inline reply");
      expect(requests.map(({ method, url }) => [method, new URL(url).pathname])).toEqual([
        ["PATCH", "/repos/owner/repo/pulls/7"],
        ["POST", "/repos/owner/repo/issues/7/comments"],
        ["POST", "/repos/owner/repo/pulls/7/comments/44/replies"],
      ]);
      expect(requests.every((request) => request.authorization === "Bearer gho_test")).toBe(true);
    });
  });

  it.effect("uploads raw bytes to the fixed upload endpoint with repository association", () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const { client, requests } = fakeClient((request) => {
      if (request.url.startsWith("https://api.github.test/")) {
        return json({ id: 1234, permissions: { push: true } });
      }
      return json(
        { url: "https://github.com/user-attachments/assets/3f3c2f10-7b5b-4b9c-8cf6-6a19a6f28662" },
        201,
      );
    });
    const api = makeAgentGitHubApi(client, endpoints);

    return Effect.gen(function* () {
      const uploaded = yield* api.agentImage(
        "gho_test",
        "owner/repo",
        "screen.png",
        "image/png",
        bytes,
      );
      expect(uploaded).toEqual({
        url: "https://github.com/user-attachments/assets/3f3c2f10-7b5b-4b9c-8cf6-6a19a6f28662",
      });
      const upload = requests[1];
      expect(upload?.method).toBe("POST");
      expect(upload?.url).toMatch(/^https:\/\/uploads\.github\.test\/user-attachments\/assets\?/);
      const uploadUrl = new URL(upload?.url ?? "https://invalid.test");
      expect(uploadUrl.searchParams.get("name")).toBe("screen.png");
      expect(uploadUrl.searchParams.get("content_type")).toBe("image/png");
      expect(uploadUrl.searchParams.get("repository_id")).toBe("1234");
      expect(upload?.authorization).toBe("token gho_test");
      expect(upload?.accept).toBe("application/vnd.github+json");
      expect(upload?.contentType).toBe("application/octet-stream");
      expect(upload?.body).toEqual(bytes);
      expect(upload?.bodyLength).toBe(bytes.byteLength);
    });
  });

  it.effect("does not expose GitHub error bodies", () => {
    const token = "gho_secret_canary";
    const { client, requests } = fakeClient((request) => {
      if (request.url.startsWith("https://api.github.test/")) {
        return json({ id: 1234, permissions: { push: true } });
      }
      return new Response(token, {
        status: 302,
        headers: { location: "https://attacker.invalid/upload" },
      });
    });
    const api = makeAgentGitHubApi(client, endpoints);
    const logLines: Array<string> = [];

    return Effect.gen(function* () {
      const error = yield* api
        .agentImage(token, "owner/repo", "screen.png", "image/png", new Uint8Array([1]))
        .pipe(Effect.flip);
      expect(error.message).toBe("GitHub agentImage failed (HTTP 302).");
      expect(error.message).not.toContain(token);
      expect(requests).toHaveLength(2);
      expect(logLines.join("\n")).not.toContain(token);
    }).pipe(
      Effect.provide(
        Logger.layer([Logger.map(Logger.formatJson, (line) => void logLines.push(line))]),
      ),
    );
  });

  it.effect("uses manual redirects for image uploads and keeps the upload URL fixed", () => {
    const requests: Array<{
      readonly url: string;
      readonly redirect: RequestRedirect | undefined;
    }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, redirect: init?.redirect });
      if (url.startsWith("https://api.github.test/")) {
        return Response.json({ id: 1234, permissions: { push: true } });
      }
      return new Response("private response body", {
        status: 302,
        headers: { location: "https://attacker.invalid/collect" },
      });
    };

    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const api = makeAgentGitHubApi(client, endpoints);
      const error = yield* api
        .agentImage("gho_test", "owner/repo", "screen.png", "image/png", new Uint8Array([1]))
        .pipe(Effect.flip);
      expect(error.message).toBe("GitHub agentImage failed (HTTP 302).");
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.redirect === "manual")).toBe(true);
      const apiUrl = new URL(requests[0]?.url ?? "https://invalid.test");
      expect(apiUrl.href).toBe("https://api.github.test/repos/owner/repo");
      const uploadUrl = new URL(requests[1]?.url ?? "https://invalid.test");
      expect(uploadUrl.origin).toBe("https://uploads.github.test");
      expect(uploadUrl.pathname).toBe("/user-attachments/assets");
      expect(uploadUrl.searchParams.get("name")).toBe("screen.png");
      expect(uploadUrl.searchParams.get("content_type")).toBe("image/png");
      expect(uploadUrl.searchParams.get("repository_id")).toBe("1234");
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });
});
