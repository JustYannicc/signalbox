import {
  AuthOrchestrationReadScope,
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
      setThreadResolution: (input) =>
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
