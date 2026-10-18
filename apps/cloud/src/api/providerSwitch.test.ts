import { operations } from "@signalbox/api/catalog";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { poolInstanceId } from "@t3tools/contracts/accountHub";
import { SIGNALBOX_FOLDERS_WS_METHODS } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import { type ApiAnswer, type ApiCaller, callOperation } from "./apiCall.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "switch-owner";
const strangerId = "switch-stranger";
const threadId = ThreadId.make("provider-switch-thread");
const claudePoolModel = "claude-opus-5-5";
const writeScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
];
const switchProviderOperation = operations.find(
  (candidate) => candidate.name === "threads.switchProvider",
)!;

const json = (answer: ApiAnswer) => {
  if (answer._tag !== "json") throw new Error("Expected a JSON answer");
  return answer;
};

const apiCaller = (personId: string, scopes: ApiCaller["scopes"]): ApiCaller => ({
  userId: personId,
  kind: "person",
  scopes,
  credentialId: `session-${personId}`,
});

const callProviderSwitch = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  caller: ApiCaller,
  command: ReturnType<typeof providerSwitch>,
) =>
  callOperation({
    operation: switchProviderOperation,
    body: {
      commandId: command.commandId,
      threadId: command.threadId,
      modelSelection: command.modelSelection,
    },
    follow: false,
    caller,
    identity,
  }).pipe(Effect.provide(cloud.layerFor(caller.userId)));

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory
    .forUser(userId)
    .recordSignIn({ id: userId, email: "owner@example.test" });
  yield* cloud.userDirectory
    .forUser(strangerId)
    .recordSignIn({ id: strangerId, email: "stranger@example.test" });

  const clientFor = (personId: string, scopes: (typeof writeScopes)[number][]) =>
    RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudRpc.layerHandlers({
            identity,
            userId: personId,
            sid: `session-${personId}`,
          }),
          CloudRpc.layerScopeAuthorization(scopes),
        ).pipe(Layer.provide(cloud.layerFor(personId))),
      ),
    );
  const owner = yield* clientFor(userId, writeScopes);

  const accountPool = yield* owner[WS_METHODS.accountPoolCreate]({ name: "Folder pool" });
  const poolObjectName = PoolDirectory.poolObjectName(userId, accountPool.id);
  const pool = cloud.pools.directory.forPool(poolObjectName);
  const login = yield* pool.startLogin({ userId }, "claude");
  yield* pool.completeLogin({ userId }, `http://localhost/callback?code=c&state=${login.state}`);
  yield* pool.loginStatus({ userId }, login.state);

  const created = yield* owner[SIGNALBOX_FOLDERS_WS_METHODS.create]({
    name: "Provider switch",
    parentId: null,
  });
  const folderId = created.folders.find((folder) => folder.name === "Provider switch")!.id;
  yield* owner[SIGNALBOX_FOLDERS_WS_METHODS.update]({ id: folderId, poolId: accountPool.id });
  yield* owner[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make("launch-provider-switch"),
    threadId,
    projectId: Environment.SCRATCH_PROJECT_ID,
    title: "Provider switch",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  yield* owner[SIGNALBOX_FOLDERS_WS_METHODS.moveThread]({ threadId, folderId });

  return { cloud, owner, accountPool, pool, poolObjectName };
});

const providerSwitch = (
  commandId: string,
  selection: { readonly instanceId: ProviderInstanceId; readonly model: string },
) => ({
  type: "provider.switch" as const,
  commandId: CommandId.make(commandId),
  threadId,
  modelSelection: selection,
});

describe("Cloud provider switch", () => {
  it.effect(
    "uses the folder pool, normalizes its instance, and replays before checking the catalog",
    () =>
      Effect.gen(function* () {
        const { cloud, owner, accountPool, pool } = yield* setup;
        expect(switchProviderOperation).toMatchObject({
          access: "write",
          command: "provider.switch",
        });

        const command = providerSwitch("switch-to-claude", {
          instanceId: ProviderInstanceId.make(poolInstanceId("claude", "not-the-folder-pool")),
          model: claudePoolModel,
        });
        const accepted = json(
          yield* callProviderSwitch(cloud, apiCaller(userId, writeScopes), command),
        );
        expect(accepted.status).toBe(200);
        const projection = yield* owner[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId,
        });
        expect(projection.thread.modelSelection).toEqual({
          instanceId: poolInstanceId("claude", accountPool.id),
          model: claudePoolModel,
        });

        const { accounts } = yield* pool.accounts({ userId });
        yield* pool.updateAccount({ userId }, accounts[0]!.name, "remove");

        const replay = json(
          yield* callProviderSwitch(cloud, apiCaller(userId, writeScopes), command),
        );
        expect(replay).toEqual(accepted);
        expect(
          (yield* owner[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId })).thread
            .modelSelection,
        ).toEqual(projection.thread.modelSelection);
        expect(yield* cloud.threadEvents(threadId)).toContainEqual(
          expect.objectContaining({ type: "thread.provider-switched" }),
        );
      }),
  );

  it.effect(
    "refuses unavailable targets without changing history, enforces write scope, and hides the thread",
    () =>
      Effect.gen(function* () {
        const { cloud, owner } = yield* setup;
        const beforeProjection = yield* owner[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId,
        });
        const beforeEvents = yield* cloud.threadEvents(threadId);

        const readOnly = json(
          yield* callProviderSwitch(
            cloud,
            apiCaller(userId, [AuthOrchestrationReadScope]),
            providerSwitch("read-only-switch", {
              instanceId: ProviderInstanceId.make(poolInstanceId("claude", "folder-pool")),
              model: claudePoolModel,
            }),
          ),
        );
        expect(readOnly.status).toBe(403);
        expect(readOnly.body).toMatchObject({ error: { _tag: "EnvironmentAuthorizationError" } });

        const targetNotServed = json(
          yield* callProviderSwitch(
            cloud,
            apiCaller(userId, writeScopes),
            providerSwitch("switch-unserved-model", {
              instanceId: ProviderInstanceId.make(poolInstanceId("claude", "untrusted-suffix")),
              model: "claude-not-in-the-live-pool",
            }),
          ),
        );
        expect(targetNotServed).toMatchObject({
          status: 422,
          body: {
            error: {
              _tag: "OrchestrationV2DispatchCommandError",
              message:
                "This pool doesn't serve claude-not-in-the-live-pool right now. Pick another model.",
            },
          },
        });

        const unsupportedHarness = json(
          yield* callProviderSwitch(
            cloud,
            apiCaller(userId, writeScopes),
            providerSwitch("switch-unsupported-harness", {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "cursor-model",
            }),
          ),
        );
        expect(unsupportedHarness).toMatchObject({
          status: 422,
          body: {
            error: {
              _tag: "OrchestrationV2DispatchCommandError",
              message:
                "That harness isn't available in Signalbox Cloud. Choose Claude or Codex from a pool.",
            },
          },
        });

        const hidden = json(
          yield* callProviderSwitch(
            cloud,
            apiCaller(strangerId, [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
            providerSwitch("stranger-switch", {
              instanceId: ProviderInstanceId.make(poolInstanceId("claude", "folder-pool")),
              model: claudePoolModel,
            }),
          ),
        );
        expect(hidden).toMatchObject({
          status: 422,
          body: {
            error: { _tag: "OrchestrationV2DispatchCommandError", message: "Thread not found." },
          },
        });

        expect(
          (yield* owner[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId })).thread
            .modelSelection,
        ).toEqual(beforeProjection.thread.modelSelection);
        expect(yield* cloud.threadEvents(threadId)).toEqual(beforeEvents);
      }),
  );
});
