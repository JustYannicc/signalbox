import { CommandId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as Environment from "../../environment.ts";
import * as GitHub from "../../github/GitHub.ts";
import type { GitHubApi } from "../../github/GitHubApi.ts";
import { GitHubError as GitHubErrorTag } from "../../github/GitHubApi.ts";
import { makeMemoryCloud } from "../../testing.ts";
import * as CloudThreadService from "../CloudThreadService.ts";
import { scriptedModelSelection } from "../scriptedProvider.ts";

const ownerId = "pull-request-owner";
const threadId = ThreadId.make("pull-request-refresh-thread");
const actor = { userId: ownerId, contextIds: [PERSONAL_CONTEXT_ID] };
const key = "github.test/owner/repo#7";

const githubLayer = (
  tokens: Array<string>,
  getRetryAt: () => number | null,
  getAnswer: () => string | null = () => null,
) => {
  const pipes: GitHub.GitHubPipes = {
    authorizeUrl: () => Effect.succeed("https://github.test/connect"),
    accessToken: (userId) =>
      Effect.succeed({
        _tag: "active",
        token: Redacted.make(`token:${userId}`),
        expiresAt: null,
        missingScopes: [],
      }),
    disconnect: () => Effect.void,
  };
  const api = {
    host: "github.test",
    viewer: () => Effect.succeed({ login: "octo", id: 1, name: "Octo" }),
    graphql: (operation: string, token: string) => {
      tokens.push(token);
      const retryAt = getRetryAt();
      return retryAt === null
        ? Effect.succeed(getAnswer())
        : Effect.fail(
            new GitHubErrorTag({
              operation,
              status: 403,
              message: "rate limited",
              retryAt,
            }),
          );
    },
  } as unknown as GitHubApi;
  return Layer.succeed(GitHub.GitHub, GitHub.GitHub.of({ pipes, api }));
};

describe("CloudThreadService.requestPullRequestSync", () => {
  it.effect("checks the current link, reads as the owner, and preserves rate-limit backoff", () => {
    const tokens: Array<string> = [];
    let retryAt: number | null = null;
    const cloud = makeMemoryCloud({ github: githubLayer(tokens, () => retryAt) });
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(ownerId);
      yield* user.recordSignIn({ id: ownerId, email: "owner@example.test" });
      yield* user.beginGitHubConnect({
        grantId: "github-connect",
        returnTo: "https://signalbox.test",
      });
      expect(yield* user.completeGitHubConnect("github-connect")).toEqual({
        _tag: "connected",
        login: "octo",
      });

      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(cloud.layerPersonal(ownerId)),
      );
      yield* service.launchThread(actor, {
        commandId: CommandId.make("launch-refresh-thread"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Refresh pull request",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      yield* service.dispatchCommand(actor, {
        type: "thread.pull-request.link",
        commandId: CommandId.make("link-refresh-pr"),
        threadId,
        host: "github.test",
        repository: "owner/repo",
        number: 7,
        url: "https://github.test/owner/repo/pull/7",
        source: "manual",
      });

      const hidden = yield* service
        .requestPullRequestSync(
          { userId: "someone-else", contextIds: [PERSONAL_CONTEXT_ID] },
          threadId,
          key,
        )
        .pipe(Effect.flip);
      expect(hidden).toMatchObject({ _tag: "ThreadNotFoundError" });
      const missing = yield* service
        .requestPullRequestSync(actor, threadId, "github.test/owner/repo#8")
        .pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "ThreadNotFoundError" });
      expect(tokens).toEqual([]);

      yield* service.requestPullRequestSync(actor, threadId, key);
      expect(tokens).toEqual([`token:${ownerId}`]);

      retryAt = (yield* cloud.threadNow(threadId)) + 60 * 60_000;
      yield* service.requestPullRequestSync(actor, threadId, key);
      expect(tokens).toEqual([`token:${ownerId}`, `token:${ownerId}`]);
      retryAt = null;
      yield* service.requestPullRequestSync(actor, threadId, key);
      // The immediate refresh stayed behind the persisted retryAt, even after the upstream stopped rate limiting.
      expect(tokens).toEqual([`token:${ownerId}`, `token:${ownerId}`]);
    });
  });

  it.effect("arms immediate delivery when a refresh newly merges a pull request", () => {
    const tokens: Array<string> = [];
    const merged = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 7,
            title: "Merged change",
            url: "https://github.test/owner/repo/pull/7",
            state: "MERGED",
            isDraft: false,
            mergeable: "MERGEABLE",
            reviewDecision: null,
            additions: 3,
            deletions: 1,
            changedFiles: 1,
            updatedAt: "2026-10-17T09:00:00.000Z",
            mergedAt: "2026-10-17T09:00:00.000Z",
            closedAt: "2026-10-17T09:00:00.000Z",
            headRefName: "feature",
            baseRefName: "main",
            author: {
              __typename: "User",
              login: "octo",
              avatarUrl: "https://avatars.githubusercontent.com/u/1",
              name: "Octo",
            },
            latestReviews: { nodes: [] },
            commits: { nodes: [] },
          },
        },
      },
    });
    const cloud = makeMemoryCloud({
      github: githubLayer(
        tokens,
        () => null,
        () => merged,
      ),
    });
    return Effect.gen(function* () {
      const user = cloud.userDirectory.forUser(ownerId);
      yield* user.recordSignIn({ id: ownerId, email: "owner@example.test" });
      yield* user.beginGitHubConnect({
        grantId: "github-connect-merged",
        returnTo: "https://signalbox.test",
      });
      expect(yield* user.completeGitHubConnect("github-connect-merged")).toMatchObject({
        _tag: "connected",
      });

      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(cloud.layerPersonal(ownerId)),
      );
      yield* service.launchThread(actor, {
        commandId: CommandId.make("launch-merged-refresh"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Refresh merged pull request",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      yield* service.dispatchCommand(actor, {
        type: "thread.pull-request.link",
        commandId: CommandId.make("link-merged-refresh"),
        threadId,
        host: "github.test",
        repository: "owner/repo",
        number: 7,
        url: "https://github.test/owner/repo/pull/7",
        source: "manual",
      });

      const requestedAt = yield* cloud.threadNow(threadId);
      yield* service.requestPullRequestSync(actor, threadId, key);

      expect(tokens).toEqual([`token:${ownerId}`]);
      const alarmAt = cloud.threadAlarmAt(threadId);
      expect(alarmAt).toBeDefined();
      expect(alarmAt).toBeGreaterThanOrEqual(requestedAt - 10_000);
      expect(alarmAt).toBeLessThanOrEqual(requestedAt + 1_000);
      expect(
        (yield* cloud.threadEvents(threadId)).some(
          (event) =>
            event.type === "thread.pull-request-synced" &&
            event.payload.pullRequests?.some((link) => link.snapshot?.state === "merged"),
        ),
      ).toBe(true);
    });
  });
});
