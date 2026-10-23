import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudAttachments from "../attachments/CloudAttachments.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { myDriveId } from "../drive/driveAccess.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as SearchSettings from "../search/searchSettings.ts";
import * as ThreadContexts from "../user/threadContexts.ts";
import * as ThreadKindTurns from "./ThreadKindTurns.ts";
import * as StandaloneThread from "./StandaloneThread.ts";

const userId = "standalone-owner";
const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("standalone-thread");

const poolReplyRejected = async () => ({
  _tag: "rejected" as const,
  reason: "This operation is outside the test's pool policy.",
});

const poolDirectory = PoolDirectory.PoolDirectory.of({
  forPool: () =>
    PoolDirectory.handleFor({
      create: poolReplyRejected,
      info: poolReplyRejected,
      rename: poolReplyRejected,
      setRouting: poolReplyRejected,
      setBacking: poolReplyRejected,
      delete: poolReplyRejected,
      accounts: poolReplyRejected,
      advice: poolReplyRejected,
      models: async () => ({
        _tag: "ok",
        value: {
          checkedAt: 1,
          attemptedAt: 1,
          models: [
            { id: "claude-opus-5-5", ownedBy: "anthropic", created: null, provider: "claude" },
          ],
        },
      }),
      startLogin: poolReplyRejected,
      loginStatus: poolReplyRejected,
      completeLogin: poolReplyRejected,
      cancelLogin: poolReplyRejected,
      logoutAccount: poolReplyRejected,
      updateAccount: poolReplyRejected,
      openLink: poolReplyRejected,
    }),
});

const attachmentLayer = Layer.succeed(
  CloudAttachments.CloudAttachments,
  CloudAttachments.CloudAttachments.of({
    persistImages: () => Effect.die(new Error("Image persistence is not part of this test.")),
    issueUpload: () => Effect.die(new Error("Uploads are not part of this test.")),
    storeUpload: () => Effect.succeed({ _tag: "unknown" }),
    deletePending: () => Effect.void,
    canRead: () => Effect.succeed(false),
    open: () => Effect.succeed(null),
    claim: () =>
      Effect.fail(new CloudAttachments.AttachmentRejectedError({ reason: "No attachments here." })),
  }),
);

const machineLayer = Layer.effect(
  StandaloneThread.MachineBackend,
  Effect.gen(function* () {
    const records = yield* StandaloneThread.MachineRecords;
    const none = {
      kind: "none" as const,
      shape: null,
      image: null,
      connectTimeoutMs: 1_000,
      idleTailMs: 0,
      ensure: () => Effect.die(new Error("No machine is provisioned in this test.")),
      stop: () =>
        Effect.succeed({ desired: "stopped" as const, actual: "none" as const, machineId: null }),
      destroy: () =>
        Effect.succeed({ desired: "destroyed" as const, actual: "none" as const, machineId: null }),
      inspect: () =>
        Effect.map(records.get, ({ desired, machineId }) => ({
          desired,
          actual: "none" as const,
          machineId,
        })),
      refresh: () => Effect.die(new Error("No machine is provisioned in this test.")),
      refreshEveryMs: null,
      pending: Effect.succeed(false),
    } satisfies StandaloneThread.MachineBackendShape;
    return StandaloneThread.MachineBackend.of({ light: none, heavy: none });
  }),
);

const platform = Layer.mergeAll(
  Layer.succeed(PoolDirectory.PoolDirectory, poolDirectory),
  attachmentLayer,
  machineLayer,
  Layer.succeed(SearchSettings.SearchSettings, { generation: "test", disabled: true }),
  Layer.succeed(
    ThreadContexts.ThreadContexts,
    ThreadContexts.ThreadContexts.of({
      initialModelSelection: () => Effect.succeed(null),
      placeOfProject: (projectId) =>
        Effect.succeed(
          projectId === ProjectId.make("scratch")
            ? {
                contextId: PERSONAL_CONTEXT_ID,
                driveId: myDriveId(PERSONAL_CONTEXT_ID, userId),
                remote: false,
              }
            : null,
        ),
      turn: () =>
        Effect.succeed({
          pools: { top: PERSONAL_POOL_ID, projects: {} },
          instructions: { top: [], projects: {} },
          secrets: { top: [], projects: {} },
        }),
    }),
  ),
  ThreadKindTurns.layerNone,
  Layer.succeed(
    StandaloneThread.ThreadDrives,
    StandaloneThread.ThreadDrives.of({
      enabled: false,
      writes: () => Effect.succeed(false),
      commitAuthor: () => Effect.succeed(null),
    }),
  ),
  Layer.succeed(
    StandaloneThread.ThreadSecrets,
    StandaloneThread.ThreadSecrets.of({ token: () => Effect.succeed(null) }),
  ),
);

const launchInput = (id: string, model: string) => ({
  commandId: CommandId.make(`launch-${id}`),
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("scratch"),
  title: "Standalone thread",
  modelSelection: { instanceId: ProviderInstanceId.make("claude_hub"), model },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspaceStrategy: { type: "root" } as const,
  initialMessage: {
    messageId: MessageId.make(`message-${id}`),
    text: "Persist this thread.",
    attachments: [],
  },
});

describe("StandaloneThread", () => {
  it.effect("routes live Threads calls through the SQLite engine and current model policy", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        StandaloneThread.layer({
          threadId,
          sql: NodeSqliteClient.layer({ filename: ":memory:" }),
          platform,
        }),
      );
      const threads = Context.get(context, StandaloneThread.Threads);

      yield* Effect.gen(function* () {
        const refused = yield* Effect.flip(
          threads.launch(actor, { ...launchInput("unserved", "claude-not-served"), threadId }),
        );
        expect(refused._tag).toBe("ThreadCommandRejectedError");

        const launched = yield* threads.launch(actor, launchInput(threadId, "claude-opus-5-5"));
        expect(launched.projection.thread.id).toBe(threadId);
        const snapshot = yield* threads.snapshot(actor, threadId);
        expect(snapshot.projection.thread.modelSelection.model).toBe("claude-opus-5-5");

        const stranger = { userId: "other-user", contextIds: [PERSONAL_CONTEXT_ID] };
        expect((yield* Effect.flip(threads.snapshot(stranger, threadId)))._tag).toBe(
          "ThreadNotFoundError",
        );
      }).pipe(Effect.provide(context));
    }).pipe(Effect.scoped),
  );
});
