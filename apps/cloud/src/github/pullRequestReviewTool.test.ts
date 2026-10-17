import { AUTOMATION_PATHS } from "@signalbox/runner-protocol/AutomationProtocol";
import { PULL_REQUEST_REVIEW_TOOL } from "@signalbox/runner-protocol/PullRequestReviewTools";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { automationTool } from "../automations/automationTool.ts";
import { handleDriveRequest, type DriveRouteEnv } from "../drive/driveRoutes.ts";
import { driveToken } from "../drive/driveToken.ts";
import { makeMemoryCloud } from "../testing.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import type { DriveAuthorization } from "../thread/ThreadAuthorization.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { CloudPullRequests } from "./CloudPullRequestsService.ts";
import { failure, fixture, reply, storage } from "./pullRequestCollaborationTesting.ts";
import { pullRequestReviewTool } from "./pullRequestReviewTool.ts";

const userId = "user-1";
const actorThreadId = ThreadId.make("review-worker");
const setup = Effect.gen(function* () {
  const f = yield* fixture;
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory
    .forUser(userId)
    .recordSignIn({ id: userId, email: "test@example.com" });
  const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(userId)));
  yield* threads.launchThread(
    { userId, contextIds: [PERSONAL_CONTEXT_ID] },
    {
      commandId: CommandId.make("launch-review"),
      threadId: actorThreadId,
      projectId: reply.projectId,
      title: "Review",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("review-message"),
        text: "Review",
        attachments: [],
      },
    },
  );
  yield* cloud.settle;
  const dependencies = Layer.mergeAll(
    f.dependencies,
    Layer.succeed(CloudThreadService, threads),
    Layer.mock(CloudPullRequests, {
      ...f.writes,
      activity: () =>
        Effect.succeed({
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
          commits: [],
          reviewThreads: [
            {
              id: "PRRT_1",
              path: "fixture.txt",
              line: 1,
              side: "right",
              isResolved: f.state.resolved,
              isOutdated: false,
              comments: [
                {
                  id: "PRRC_1",
                  author: null,
                  body: "Please fix this.",
                  createdAt: "2026-10-17T18:42:20.000Z",
                  url: null,
                },
              ],
            },
          ],
        }),
    }),
    Layer.mock(UserDrives, {
      userId: Effect.succeed(userId),
      contextIds: Effect.succeed([PERSONAL_CONTEXT_ID]),
      access: () => Effect.sync(() => f.state.role),
    }),
  );
  const call = (input: unknown) =>
    automationTool(actorThreadId, PULL_REQUEST_REVIEW_TOOL, input).pipe(
      Effect.provide(dependencies),
    );
  return { ...f, dependencies, call };
});

describe("folder agent PR review reach", () => {
  it.effect("reads, replies, replays and resolves using the authenticated thread's folder", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      expect(yield* f.call({ action: "read", number: 12 })).toMatchObject({
        _tag: "ok",
        result: { reviewThreads: [{ id: "PRRT_1", comments: [{ id: "PRRC_1" }] }] },
      });
      const write = {
        action: "reply",
        number: 12,
        threadId: "PRRT_1",
        body: "Fixed in abc123.",
        operationId: "disposition-1",
        repository: "other/private",
        projectId: "other-project",
        actorThreadId: "other-thread",
      };
      expect(yield* f.call(write)).toMatchObject({ _tag: "ok", result: { written: true } });
      expect(yield* f.call(write)).toMatchObject({ _tag: "ok" });
      expect(f.state.writes).toBe(1);
      expect(
        yield* f.call({ action: "resolve", number: 12, threadId: "PRRT_1", resolved: true }),
      ).toMatchObject({ _tag: "ok", result: { resolved: true } });
      expect(f.state.resolved).toBe(true);
      expect(f.state.tokens.every((token) => token === "token-123")).toBe(true);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("retains permission and rate-limit errors in the agent's tool result", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      f.state.failure = failure(200, 123_456);
      expect(
        yield* f.call({
          action: "reply",
          number: 12,
          threadId: "PRRT_1",
          body: "Fixed.",
          operationId: "reply-1",
        }),
      ).toMatchObject({
        _tag: "failed",
        error: {
          _tag: "PullRequestOperationError",
          reason: "rate-limit",
          status: 429,
          retryAt: 123_456,
        },
      });
      f.state.failure = null;
      f.state.role = "viewer";
      expect(
        yield* f.call({ action: "resolve", number: 12, threadId: "PRRT_1", resolved: true }),
      ).toMatchObject({ _tag: "failed", error: { reason: "permission" } });
      expect(
        yield* pullRequestReviewTool("another-thread", { action: "read", number: 12 }).pipe(
          Effect.provide(f.dependencies),
        ),
      ).toMatchObject({ _tag: "failed", error: { reason: "permission" } });
    }).pipe(Effect.provide(storage)),
  );

  it.effect("refuses malformed replies before the provider can create a comment", () =>
    Effect.gen(function* () {
      const f = yield* setup;
      expect(
        yield* f.call({ action: "reply", number: 12, threadId: "PRRT_1", body: "Fixed." }),
      ).toMatchObject({ _tag: "failed", error: { reason: "invalid" } });
      expect(f.state.writes).toBe(0);
    }).pipe(Effect.provide(storage)),
  );

  it.effect("exposes the tool through a live drive token and rejects idle or foreign tokens", () =>
    Effect.gen(function* () {
      const token = yield* driveToken("lease-secret", actorThreadId, 1);
      let live = true;
      const forwarded: Array<{ threadId: string; name: string; raw: unknown }> = [];
      const env = {
        THREADS: {
          jurisdiction: () => ({ idFromName: (id: string) => id }),
          idFromName: (id: string) => id,
          get: () => ({
            authorizeDrive: async (supplied: string): Promise<DriveAuthorization> =>
              supplied === token
                ? {
                    _tag: "granted",
                    threadId: actorThreadId,
                    userId,
                    driveId: `my/personal/${userId}`,
                    generation: 1,
                    live,
                  }
                : { _tag: "denied", reason: "Not this turn." },
          }),
        },
        USERS: {
          jurisdiction: () => ({ idFromName: (id: string) => id }),
          idFromName: (id: string) => id,
          get: () => ({
            automationTool: async (threadId: string, name: string, raw: unknown) => {
              forwarded.push({ threadId, name, raw });
              return { _tag: "ok", result: { written: true } };
            },
          }),
        },
        DRIVES: {},
        DRIVE_PACKS: {},
      } as unknown as DriveRouteEnv;
      const call = (credential: string) =>
        Effect.promise(() =>
          handleDriveRequest(
            env,
            new Request(`https://cloud.test${AUTOMATION_PATHS.tool}`, {
              method: "POST",
              headers: { authorization: `Bearer ${credential}` },
              body: JSON.stringify({
                name: PULL_REQUEST_REVIEW_TOOL,
                input: {
                  action: "reply",
                  number: 12,
                  threadId: "PRRT_1",
                  body: "Fixed.",
                  operationId: "drive-reply",
                },
              }),
            }),
            { localWorkerd: true },
          ),
        );
      const posted = yield* call(token);
      expect(posted.status).toBe(200);
      expect(yield* Effect.promise(() => posted.json())).toMatchObject({
        _tag: "ok",
        result: { written: true },
      });
      live = false;
      expect((yield* call(token)).status).toBe(403);
      expect((yield* call("invalid-token")).status).toBe(401);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toMatchObject({
        threadId: actorThreadId,
        name: PULL_REQUEST_REVIEW_TOOL,
        raw: { operationId: "drive-reply" },
      });
    }).pipe(Effect.provide(storage)),
  );
});
