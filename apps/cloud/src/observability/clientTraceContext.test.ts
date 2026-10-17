import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import * as CloudRpc from "../user/rpc.ts";
import * as UserFolders from "../user/UserFolders.ts";
import { wire } from "../thread/threadWire.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "trace-owner";
const otherUserId = "trace-other";
const baseThreadId = ThreadId.make("7b2dd8b5-cfee-49a1-86ce-bac041bf43b1");
const activeThreadId = ThreadId.make("8b9b5f11-587e-4ed0-a363-87f462deddd9");
const departedThreadId = ThreadId.make("4db8a0f6-a11e-499c-892b-3ea2af7240db");
const foreignThreadId = ThreadId.make("90f2a4bd-1178-4ebf-832f-642695d2a8e1");
const activeOrg = SignalboxContextId.make("org_01ARZ3NDEKTSV4RRFFQ69G5FAV");
const departedOrg = SignalboxContextId.make("org_01ARZ3NDEKTSV4RRFFQ69G5FAW");

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const user = cloud.userDirectory.forUser(userId);
  yield* user.recordSignIn({ id: userId, email: "trace@example.com" });
  yield* user.syncOrganizations([
    { id: activeOrg, name: "Active" },
    { id: departedOrg, name: "Departed" },
  ]);

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
  yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make("trace-context-launch"),
    threadId: baseThreadId,
    projectId: Environment.SCRATCH_PROJECT_ID,
    title: "Trace context fixture",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: {
      messageId: MessageId.make("trace-context-message"),
      text: "Fixture",
      attachments: [],
    },
  });
  yield* cloud.settle;
  const base = (yield* cloud.threadDirectory
    .forThread(baseThreadId)
    .summary({ userId, contextIds: [] }))!;
  const summaryFor = (threadId: ThreadId, contextId: SignalboxContextId): ThreadSummary => ({
    ...base,
    threadId,
    contextId,
    revision: base.revision + 1,
    shell: { ...base.shell, id: threadId },
  });
  yield* user.recordThreadSummary(wire.summary.encode(summaryFor(activeThreadId, activeOrg)));
  yield* user.recordThreadSummary(wire.summary.encode(summaryFor(departedThreadId, departedOrg)));

  const folder = yield* UserFolders.UserFolders.use((folders) =>
    folders.create({ name: "Active folder", parentId: null, ownerId: activeOrg }),
  ).pipe(Effect.provide(cloud.layerFor(userId)));
  const folderId = folder.folders[0]!.id;
  yield* UserFolders.UserFolders.use((folders) =>
    folders.moveThread({ threadId: activeThreadId, folderId }),
  ).pipe(Effect.provide(cloud.layerFor(userId)));

  const other = cloud.userDirectory.forUser(otherUserId);
  yield* other.recordSignIn({ id: otherUserId, email: "other@example.com" });
  yield* other.recordThreadSummary(wire.summary.encode(summaryFor(foreignThreadId, activeOrg)));

  return { cloud, user, folderId };
});

describe("client trace dimensions", () => {
  it.effect("uses the user's current indexed thread, folder and organization state", () =>
    Effect.gen(function* () {
      const { user, folderId } = yield* setup;
      const requested = [
        activeThreadId,
        departedThreadId,
        foreignThreadId,
        "not-a-generated-thread-id",
      ];

      expect(yield* user.clientTraceDimensions(requested)).toEqual([
        { threadId: activeThreadId, folderId, orgId: activeOrg },
        { threadId: departedThreadId, folderId: null, orgId: departedOrg },
      ]);

      yield* user.syncOrganizations([{ id: activeOrg, name: "Active" }]);
      expect(yield* user.clientTraceDimensions(requested)).toEqual([
        { threadId: activeThreadId, folderId, orgId: activeOrg },
      ]);
    }).pipe(Effect.scoped),
  );
});
