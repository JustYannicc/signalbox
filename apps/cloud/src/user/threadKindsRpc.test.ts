import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { SIGNALBOX_THREAD_KINDS_WS_METHODS } from "@t3tools/contracts/signalboxThreadKinds";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { ids } from "../thread/threadEvents.ts";
import { wire } from "../thread/threadWire.ts";
import { kindInstructions } from "../threadKinds/kindInstructions.ts";
import * as KindClassifier from "../threadKinds/KindClassifier.ts";
import * as CloudRpc from "./rpc.ts";

/**
 * Chats and tasks end to end in the in-memory cloud: a launched thread
 * classified from its first message, its turn told so, and the idle chat
 * archiving itself through its thread object and coming back.
 */

const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const userId = "user_1";
const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("thread-kind");
const DAY = 24 * 60 * 60 * 1000;

const connect = Effect.gen(function* () {
  const cloud = makeMemoryCloud({
    classifier: Layer.succeed(
      KindClassifier.KindClassifier,
      KindClassifier.KindClassifier.of({ classify: () => Effect.succeed(Option.some("chat")) }),
    ),
  });
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({ identity, userId, sid: "test-session" }),
        CloudRpc.layerScopeAuthorization([
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthSettingsWriteScope,
        ]),
      ).pipe(Layer.provide(cloud.layerFor(userId))),
    ),
  );
  return { cloud, rpc, user: cloud.userDirectory.forUser(userId) };
});

describe("chats and tasks in the cloud", () => {
  it.effect("classify a launch, tell its turn, and archive the idle chat until it's back", () =>
    Effect.gen(function* () {
      const { cloud, rpc, user } = yield* connect;
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Refunds?",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("m1"),
          text: "How do refunds work?",
          attachments: [],
        },
      });
      yield* cloud.settle;
      expect(yield* cloud.runInstructions(threadId, ids.run(threadId, 1))).toContainEqual(
        kindInstructions("chat"),
      );
      const [kinds] = yield* rpc[SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(kinds).toEqual({
        threads: [{ threadId, classified: "chat", override: null, workStartedAt: null }],
        archiveChatsAfterDays: 7,
      });

      const idleSince = DateTime.toEpochMillis((yield* user.shellSnapshot()).threads[0]!.updatedAt);
      expect(yield* user.sweepThreadKinds(idleSince + 7 * DAY - 1)).toEqual({ archived: [] });
      expect(yield* user.sweepThreadKinds(idleSince + 7 * DAY)).toEqual({ archived: [threadId] });
      yield* cloud.settle;
      const archived = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
      expect(archived.threads.map((thread) => thread.id)).toEqual([threadId]);
      expect((yield* user.shellSnapshot()).threads).toEqual([]);

      // Restored from Settings' Archived list.
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.unarchive",
        commandId: CommandId.make("restore"),
        threadId,
      });
      yield* cloud.settle;
      expect(
        (yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({})).threads,
      ).toEqual([]);
      const restored = (yield* user.shellSnapshot()).threads[0]!;
      expect(DateTime.toEpochMillis(restored.updatedAt)).toBeGreaterThanOrEqual(idleSince);
    }).pipe(Effect.scoped),
  );

  it.effect("serve flips and the archive setting, and hear when work started", () =>
    Effect.gen(function* () {
      const { cloud, rpc, user } = yield* connect;
      yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
        commandId: CommandId.make("launch"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Ideas",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("m1"),
          text: "Brainstorm names",
          attachments: [],
        },
      });
      yield* cloud.settle;
      const flipped = yield* rpc[SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]({
        threadId,
        kind: "task",
      });
      expect(flipped.threads[0]?.override).toBe("task");
      const unflipped = yield* rpc[SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]({
        threadId,
        kind: "chat",
      });
      expect(unflipped.threads[0]?.override).toBeNull();
      const longer = yield* rpc[SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays]({
        days: 30,
      });
      expect(longer.archiveChatsAfterDays).toBe(30);

      // The thread object's summary says a turn changed files.
      const summary = yield* cloud.threadDirectory.forThread(threadId).summary(actor);
      const startedAt = DateTime.makeUnsafe("2026-10-02T00:00:00Z");
      yield* user.recordThreadSummary(
        wire.summary.encode({
          ...summary!,
          revision: summary!.revision + 1,
          workStartedAt: startedAt,
        }),
      );
      const [kinds] = yield* rpc[SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(kinds?.threads[0]?.workStartedAt).toEqual(startedAt);
      // It's a task now, so it never archives itself.
      const idleSince = DateTime.toEpochMillis(summary!.shell.updatedAt);
      expect(yield* user.sweepThreadKinds(idleSince + 365 * DAY)).toEqual({ archived: [] });
    }).pipe(Effect.scoped),
  );
});
