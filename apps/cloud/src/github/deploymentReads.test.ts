import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeGitHubApi } from "./GitHubApi.ts";
import { makeDeploymentReads } from "./deploymentReads.ts";

interface SentRequest {
  readonly method: string;
  readonly path: string;
}

const makeReads = (respond: (request: SentRequest) => Response) => {
  const requests: Array<SentRequest> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const sent = { method: request.method, path: url.pathname };
      requests.push(sent);
      return HttpClientResponse.fromWeb(request, respond(sent));
    }),
  );
  return {
    requests,
    reads: makeDeploymentReads(
      makeGitHubApi(client, { web: "https://github.test", api: "https://api.github.test" }),
    ),
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const commit = "a".repeat(40);
const mergedPull = {
  merged_at: "2026-10-18T12:00:00Z",
  merge_commit_sha: commit,
  base: { ref: "main" },
};

const workflowRun = (overrides: Record<string, unknown> = {}) => ({
  id: 123,
  html_url: "https://github.test/acme/app/actions/runs/123",
  head_sha: commit,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  ...overrides,
});

describe("GitHub deployment reads", () => {
  it.effect(
    "returns the actual merge commit and base branch, then reads a matching workflow run",
    () =>
      Effect.gen(function* () {
        const { reads, requests } = makeReads((request) => {
          if (request.path === "/repos/acme/app/pulls/7") return json(mergedPull);
          if (request.path === "/repos/acme/app/actions/runs/123") return json(workflowRun());
          throw new Error(`Unexpected ${request.method} ${request.path}`);
        });

        expect(yield* reads.read("token", "acme/app", 7)).toEqual({
          commit,
          baseBranch: "main",
          run: null,
        });
        expect(yield* reads.read("token", "acme/app", 7, "123")).toEqual({
          commit,
          baseBranch: "main",
          run: {
            id: "123",
            url: "https://github.test/acme/app/actions/runs/123",
            status: "succeeded",
            commit,
          },
        });
        expect(requests).toEqual([
          { method: "GET", path: "/repos/acme/app/pulls/7" },
          { method: "GET", path: "/repos/acme/app/pulls/7" },
          { method: "GET", path: "/repos/acme/app/actions/runs/123" },
        ]);
      }),
  );

  it.effect("does not accept an open pull request's synthetic merge commit", () =>
    Effect.gen(function* () {
      const { reads, requests } = makeReads(() =>
        json({ ...mergedPull, merged_at: null, merge_commit_sha: "b".repeat(40) }),
      );

      const error = yield* Effect.flip(reads.read("token", "acme/app", 7, "123"));
      expect(error).toMatchObject({
        _tag: "GitHubError",
        operation: "deploymentReads.pullRequest",
        status: 409,
      });
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("fails closed for missing or malformed GitHub reads", () =>
    Effect.gen(function* () {
      const missing = makeReads(() => json({ message: "Not Found" }, 404));
      const missingError = yield* Effect.flip(missing.reads.read("token", "acme/app", 7));
      expect(missingError).toMatchObject({
        operation: "deploymentReads.pullRequest",
        status: 404,
      });

      const malformed = makeReads(() => json({ ...mergedPull, base: {} }));
      const malformedError = yield* Effect.flip(malformed.reads.read("token", "acme/app", 7));
      expect(malformedError).toMatchObject({
        operation: "deploymentReads.pullRequest",
        status: 200,
      });

      const missingRun = makeReads((request) =>
        request.path.endsWith("/pulls/7") ? json(mergedPull) : json({ message: "Not Found" }, 404),
      );
      const missingRunError = yield* Effect.flip(
        missingRun.reads.read("token", "acme/app", 7, "123"),
      );
      expect(missingRunError).toMatchObject({
        operation: "deploymentReads.workflowRun",
        status: 404,
      });
    }),
  );

  it.effect(
    "leaves action-required and in-flight runs pending, and never treats neutral or skipped as success",
    () =>
      Effect.gen(function* () {
        const statuses = [
          [workflowRun({ status: "in_progress", conclusion: null }), "pending"],
          [workflowRun({ conclusion: "action_required" }), "pending"],
          [workflowRun({ conclusion: "neutral" }), "failed"],
          [workflowRun({ conclusion: "skipped" }), "failed"],
        ] as const;

        for (const [run, expected] of statuses) {
          const { reads } = makeReads((request) =>
            request.path.endsWith("/pulls/7") ? json(mergedPull) : json(run),
          );
          const result = yield* reads.read("token", "acme/app", 7, "123");
          expect(result.run?.status).toBe(expected);
        }
      }),
  );

  it.effect("rejects runs whose commit, branch, or event cannot prove a deployment", () =>
    Effect.gen(function* () {
      const invalidRuns = [
        workflowRun({ head_sha: "b".repeat(40) }),
        workflowRun({ head_branch: "feature/change" }),
        workflowRun({ event: "pull_request" }),
        workflowRun({ event: "pull_request_target" }),
        workflowRun({ html_url: "not-a-url" }),
      ];

      for (const run of invalidRuns) {
        const { reads } = makeReads((request) =>
          request.path.endsWith("/pulls/7") ? json(mergedPull) : json(run),
        );
        const error = yield* Effect.flip(reads.read("token", "acme/app", 7, "123"));
        expect(error).toMatchObject({ operation: "deploymentReads.workflowRun", status: 409 });
      }
    }),
  );
});
