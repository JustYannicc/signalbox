import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as Platform from "../platform.ts";
import { layerAttachments, makeMemoryCloud } from "../testing.ts";
import { remoteThreadWorktree } from "../user/contextProjects.ts";
import { ThreadContexts, ThreadFolderTrashedError } from "../user/threadContexts.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as ThreadKindTurns from "./ThreadKindTurns.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const driveId = "folder/personal/published";
const projectId = ProjectId.make(`drive:${driveId}`);
const threadId = ThreadId.make("existing-thread");

const fixture = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  let published = false;
  let trashed = false;
  const service = yield* Threads.Threads.pipe(
    Effect.provide(
      ThreadsLive.layer.pipe(
        Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, cloud.threadDirectory)),
        Layer.provide(
          Layer.succeed(ThreadContexts, {
            initialModelSelection: () => Effect.succeed(null),
            placeOfProject: (id) =>
              Effect.suspend(() =>
                trashed
                  ? Effect.fail(new ThreadFolderTrashedError())
                  : Effect.succeed(
                      id === projectId
                        ? { contextId: PERSONAL_CONTEXT_ID, driveId, remote: published }
                        : null,
                    ),
              ),
            turn: () =>
              Effect.suspend(() =>
                trashed
                  ? Effect.fail(new ThreadFolderTrashedError())
                  : Effect.succeed({
                      pools: { top: PERSONAL_POOL_ID, projects: {} },
                      instructions: { top: [], projects: {} },
                      secrets: { top: [], projects: {} },
                    }),
              ),
          }),
        ),
        Layer.provide(ThreadKindTurns.layerNone),
        Layer.provide(Platform.layerCrypto),
        Layer.provide(layerAttachments(makeMemoryObjects())),
      ),
    ),
  );
  const launch = (id = threadId) =>
    service.launch(actor, {
      commandId: CommandId.make(`launch-${id}`),
      threadId: id,
      projectId,
      title: "Publish this folder",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make(`first-${id}`), text: "Work", attachments: [] },
    });
  const dispatch = (id: string) =>
    service.dispatch(actor, {
      type: "message.dispatch",
      commandId: CommandId.make(id),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(`message-${id}`),
      text: "Continue",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
  return {
    cloud,
    service,
    launch,
    dispatch,
    publish: () => {
      published = true;
    },
    setTrashed: (value: boolean) => {
      trashed = value;
    },
  };
});

describe("thread workspace publication", () => {
  it.effect("leaves a trashed folder's workspace alone until it is restored", () =>
    Effect.gen(function* () {
      const { cloud, service, launch, publish, dispatch, setTrashed } = yield* fixture;
      yield* launch();
      yield* cloud.settle;
      const before = yield* service.snapshot(actor, threadId);
      publish();
      setTrashed(true);
      expect(yield* service.snapshot(actor, threadId)).toEqual(before);
      const refused = yield* Effect.flip(dispatch("while-trashed"));
      expect(refused._tag).toBe("ThreadCommandRejectedError");
      expect(yield* service.snapshot(actor, threadId)).toEqual(before);
      setTrashed(false);
      yield* dispatch("after-restore");
      expect((yield* service.snapshot(actor, threadId)).projection.thread.worktreePath).toBe(
        remoteThreadWorktree(driveId, threadId).path,
      );
      yield* cloud.settle;
    }),
  );

  it.effect(
    "updates an active thread's projection and stream once without replacing its work or sessions",
    () =>
      Effect.gen(function* () {
        const { cloud, service, launch, publish } = yield* fixture;
        const launched = yield* launch();
        const before = yield* service.snapshot(actor, threadId);
        expect(before.projection.thread.branch).toBeNull();
        expect(before.projection.thread.worktreePath).toBeNull();
        publish();
        yield* service.refreshRemoteWorkspace(actor, threadId);
        const after = yield* service.snapshot(actor, threadId);
        const expected = remoteThreadWorktree(driveId, threadId);
        expect(after.projection.thread).toMatchObject({
          branch: expected.branch,
          worktreePath: expected.path,
        });
        expect(after.snapshotSequence).toBe(before.snapshotSequence + 1);
        expect(after.projection.runs).toEqual(before.projection.runs);
        expect(after.projection.providerThreads).toEqual(before.projection.providerThreads);
        expect(after.projection.providerSessions).toEqual(before.projection.providerSessions);
        expect(after.projection.messages).toEqual(before.projection.messages);
        expect(after.projection.checkpoints).toEqual(before.projection.checkpoints);
        yield* service.refreshRemoteWorkspace(actor, threadId);
        expect((yield* service.snapshot(actor, threadId)).snapshotSequence).toBe(
          after.snapshotSequence,
        );
        const replay = yield* service
          .subscribe(actor, {
            threadId,
            afterSequence: before.snapshotSequence,
            requestCompletionMarker: true,
          })
          .pipe(
            Stream.flattenIterable,
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          );
        expect(
          replay.filter((item) => item.kind === "event").map((item) => item.event.type),
        ).toEqual(["thread.metadata-updated"]);

        yield* service.dispatch(actor, {
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: launched.projection.runs[0]!.id,
          holdQueue: true,
        });
        expect((yield* service.snapshot(actor, threadId)).projection.runs[0]?.status).toBe(
          "interrupted",
        );
        yield* cloud.settle;
      }),
  );

  it.effect("lazily adopts on the next turn and gives fresh threads their own branch", () =>
    Effect.gen(function* () {
      const { cloud, service, launch, dispatch, publish } = yield* fixture;
      yield* launch();
      yield* cloud.settle;
      const before = yield* service.snapshot(actor, threadId);
      publish();
      yield* dispatch("next-turn");
      const after = yield* service.snapshot(actor, threadId);
      expect(after.projection.thread.branch).toBe(remoteThreadWorktree(driveId, threadId).branch);
      expect(after.projection.runs).toHaveLength(before.projection.runs.length + 1);
      yield* cloud.settle;
      expect((yield* service.snapshot(actor, threadId)).projection.runs.at(-1)?.status).toBe(
        "completed",
      );
      const freshId = ThreadId.make("fresh-thread");
      const fresh = yield* launch(freshId);
      expect(fresh.projection.thread).toMatchObject({
        branch: remoteThreadWorktree(driveId, freshId).branch,
        worktreePath: remoteThreadWorktree(driveId, freshId).path,
      });
      expect(fresh.projection.thread.branch).not.toBe(after.projection.thread.branch);
    }),
  );

  it.effect(
    "adopts when an existing thread is reopened and rejects client branch or host path changes",
    () =>
      Effect.gen(function* () {
        const { service, launch, publish } = yield* fixture;
        yield* launch();
        publish();
        const after = yield* service.snapshot(actor, threadId);
        expect(after.projection.thread.worktreePath).toBe(
          remoteThreadWorktree(driveId, threadId).path,
        );
        const rejected = yield* Effect.flip(
          service.dispatch(actor, {
            type: "thread.metadata.update",
            commandId: CommandId.make("forged"),
            threadId,
            branch: "main",
            worktreePath: "/etc",
          }),
        );
        expect(rejected._tag).toBe("ThreadCommandRejectedError");
        expect((yield* service.snapshot(actor, threadId)).projection.thread).toEqual(
          after.projection.thread,
        );
        expect(
          (yield* Effect.flip(
            service.refreshRemoteWorkspace({ ...actor, userId: "stranger" }, threadId),
          ))._tag,
        ).toBe("ThreadNotFoundError");
      }),
  );
});
