import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { planThreadPullRequestMutation } from "@t3tools/client-runtime/thread-pull-request-compatibility";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../../environment.ts";
import { makeMemoryCloud } from "../../testing.ts";
import * as CloudRpc from "../../user/rpc.ts";
import { scriptedModelSelection } from "../scriptedProvider.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const threadId = ThreadId.make("thread-1");
const url = "https://github.com/JustYannicc/signalbox-actions-test/pull/12";
const reference = {
  host: "github.com",
  repository: "JustYannicc/signalbox-actions-test",
  number: 12,
  url,
};

const connect = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  return { cloud, rpc };
});

type Rpc = Effect.Success<typeof connect>["rpc"];

const capabilities = (rpc: Rpc) =>
  rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([item]) => {
      if (item?.type !== "snapshot") throw new Error("Expected a config snapshot");
      return item.config.environment.capabilities;
    }),
  );

/** The thread's links as the sidebar sees them. */
const sidebarLinks = (rpc: Rpc) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([item]) => {
      if (item?.kind !== "snapshot") throw new Error("Expected a shell snapshot");
      const thread = item.snapshot.threads.find((entry) => entry.id === threadId);
      return (thread?.pullRequests ?? []).map((link) => link.url);
    }),
  );

/** Sends the command a client plans for this environment, as Thread details and the link dialog do. */
const changeLink = (
  rpc: Rpc,
  advertised: ExecutionEnvironmentCapabilities,
  linked: boolean,
  commandId: string,
) =>
  Effect.gen(function* () {
    const mutation = planThreadPullRequestMutation({
      capabilities: advertised,
      threadId,
      reference,
      legacyProjectId: null,
      linked,
    });
    if (mutation === null || mutation.type === "thread.meta.update") {
      throw new Error(`Expected a multi-link command, got ${mutation?.type ?? "none"}`);
    }
    const id = CommandId.make(commandId);
    yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
      mutation.type === "thread.pull-request.link"
        ? { ...mutation.input, type: mutation.type, commandId: id }
        : { ...mutation.input, type: mutation.type, commandId: id },
    );
  });

describe("cloud pull request links", () => {
  it.effect("advertises thread links but not the reads and watches it doesn't serve yet", () =>
    Effect.gen(function* () {
      const { rpc } = yield* connect;
      const advertised = yield* capabilities(rpc);
      expect(advertised.threadPullRequests).toBe(true);
      // `pullRequests.*` and `threads.pullRequest.watch` are gaps (#397, `api/cloudCoverage.ts`).
      expect(advertised.pullRequests).not.toBe(true);
      expect(advertised.threadPullRequestWatch).not.toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("links, unlinks and relinks a pull request from the client's plan", () =>
    Effect.gen(function* () {
      const { cloud, rpc } = yield* connect;
      const advertised = yield* capabilities(rpc);
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Ship it",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
      });
      yield* cloud.settle;
      yield* changeLink(rpc, advertised, true, "link");
      yield* cloud.settle;
      expect(yield* sidebarLinks(rpc)).toEqual([url]);

      yield* changeLink(rpc, advertised, false, "unlink");
      yield* cloud.settle;
      expect(yield* sidebarLinks(rpc)).toEqual([]);

      yield* changeLink(rpc, advertised, true, "relink");
      yield* cloud.settle;
      expect(yield* sidebarLinks(rpc)).toEqual([url]);
    }).pipe(Effect.scoped),
  );
});
