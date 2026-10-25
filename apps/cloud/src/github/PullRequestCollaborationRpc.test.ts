import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  PullRequestOperationError,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "../user/rpc.ts";
import { CloudPullRequests } from "./CloudPullRequestsService.ts";

const reference = {
  projectId: Environment.scratchProject.id,
  repository: "acme/web",
  number: 12,
  threadId: "PRRT_1",
};
const connect = (canWrite: boolean, fail = false) =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const cloud = makeMemoryCloud();
    const userId = "user-1";
    yield* cloud.userDirectory
      .forUser(userId)
      .recordSignIn({ id: userId, email: "test@example.com" });
    const service = Layer.mock(CloudPullRequests, {
      replyToThread: (input) =>
        fail
          ? Effect.fail(
              new PullRequestOperationError({
                operation: "replyToThread",
                detail: "Try later.",
                reason: "rate-limit",
                status: 429,
                retryAt: 1_234_567,
              }),
            )
          : Effect.sync(() => {
              calls.push(input);
            }),
      comment: (input) =>
        Effect.sync(() => {
          calls.push(input);
        }),
      updateComment: (input) =>
        Effect.sync(() => {
          calls.push(input);
        }),
      submitReview: (input) =>
        Effect.sync(() => {
          calls.push(input);
        }),
      setReaction: (input) =>
        Effect.sync(() => {
          calls.push(input);
        }),
      setThreadResolution: (input) =>
        Effect.sync(() => {
          calls.push(input);
        }),
      reviewGuide: () => Effect.succeed({ guide: null, run: null, currentHeadSha: "a".repeat(40) }),
      filesViewed: () => Effect.succeed({ files: [], truncated: false }),
      generateReviewGuide: () =>
        Effect.succeed({
          guide: null,
          run: { _tag: "Running", headSha: "a".repeat(40), startedAt: "2026-10-18T00:00:00.000Z" },
          currentHeadSha: "a".repeat(40),
        }),
      setFilesViewed: (input) =>
        Effect.sync(() => {
          calls.push(input);
        }),
    });
    const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity: { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" },
            userId,
            sid: "session-1",
          }).pipe(Layer.provide(Layer.mergeAll(cloud.layerFor(userId), service))),
          CloudRpc.layerScopeAuthorization(
            canWrite
              ? [AuthOrchestrationReadScope, AuthSourceControlWriteScope]
              : [AuthOrchestrationReadScope],
          ),
        ),
      ),
    );
    return { rpc, calls };
  });

describe("public cloud PR collaboration RPCs", () => {
  it.effect("reads guide/viewed state with read scope and guards their mutations", () =>
    Effect.gen(function* () {
      const f = yield* connect(false);
      expect(yield* f.rpc[WS_METHODS.pullRequestsReviewGuide](reference)).toMatchObject({
        guide: null,
      });
      expect(yield* f.rpc[WS_METHODS.pullRequestsFilesViewed](reference)).toEqual({
        files: [],
        truncated: false,
      });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsGenerateReviewGuide]({
          ...reference,
          operationId: "guide",
          headSha: "a".repeat(40),
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsSetFilesViewed]({
          ...reference,
          files: [{ path: "a.ts", viewed: true }],
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredScope: AuthSourceControlWriteScope });
      expect(f.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect("requires source-control write authority before calling the service", () =>
    Effect.gen(function* () {
      const f = yield* connect(false);
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsReplyToThread]({
          ...reference,
          body: "Fixed.",
          operationId: "reply-1",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsSetThreadResolution]({
          ...reference,
          resolved: true,
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsComment]({
          ...reference,
          body: "Hello.",
          operationId: "comment-1",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsUpdateComment]({
          ...reference,
          commentId: "IC_1",
          kind: "issue-comment",
          body: "Edited.",
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsSubmitReview]({
          ...reference,
          verdict: "approve",
          body: "",
          comments: [],
          operationId: "review-1",
          headSha: "a".repeat(40),
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsSetReaction]({
          ...reference,
          content: "thumbs-up",
          reacted: true,
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(f.calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("retains typed rate-limit details over the public RPC", () =>
    Effect.gen(function* () {
      const f = yield* connect(true, true);
      expect(
        yield* f.rpc[WS_METHODS.pullRequestsReplyToThread]({
          ...reference,
          body: "Fixed.",
          operationId: "reply-1",
        }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "PullRequestOperationError",
        reason: "rate-limit",
        status: 429,
        retryAt: 1_234_567,
      });
    }).pipe(Effect.scoped),
  );
});
