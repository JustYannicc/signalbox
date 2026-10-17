import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as DriveDirectory from "../drive/DriveDirectory.ts";
import * as Platform from "../platform.ts";
import { layerAttachments, makeMemoryCloud } from "../testing.ts";
import * as ThreadContexts from "../user/threadContexts.ts";
import { remoteThreadWorktree } from "../user/contextProjects.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserFolders from "../user/UserFolders.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as ThreadKindTurns from "./ThreadKindTurns.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const driveId = "folder/personal/workspace-reads";
const projectId = ProjectId.make(`drive:${driveId}`);
const threadId = ThreadId.make("workspace-reads");

const fixture = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const calls = { snapshot: 0, workspace: 0, dispatch: 0, subscribe: 0, remote: 0, role: 0 };
  const drives: DriveDirectory.DriveDirectory["Service"] = {
    forDrive: (id) => {
      const handle = DriveDirectory.handleFor(cloud.drives.apiFor(id));
      return {
        ...handle,
        remote: () =>
          Effect.sync(() => {
            calls.remote++;
          }).pipe(Effect.andThen(handle.remote())),
        role: (userId) =>
          Effect.sync(() => {
            calls.role++;
          }).pipe(Effect.andThen(handle.role(userId))),
      };
    },
  };
  yield* drives.forDrive(driveId).setup({
    name: "Local folder",
    members: [{ userId: actor.userId, email: "user@example.test", name: null, role: "owner" }],
  });
  const directory: ThreadDirectory.ThreadDirectory["Service"] = {
    forThread: (id) => {
      const handle = cloud.threadDirectory.forThread(id);
      return {
        ...handle,
        snapshot: (who) =>
          Effect.sync(() => {
            calls.snapshot++;
          }).pipe(Effect.andThen(handle.snapshot(who))),
        workspace: (who) =>
          Effect.sync(() => {
            calls.workspace++;
          }).pipe(Effect.andThen(handle.workspace(who))),
        dispatch: (who, command, creation) =>
          Effect.sync(() => {
            calls.dispatch++;
          }).pipe(Effect.andThen(handle.dispatch(who, command, creation))),
        subscribe: (who, input) =>
          Stream.unwrap(
            Effect.sync(() => {
              calls.subscribe++;
              return handle.subscribe(who, input);
            }),
          ),
      };
    },
  };
  const folders = yield* UserFolders.UserFolders.pipe(
    Effect.provide(cloud.userObject(actor.userId)),
  );
  const contexts = ThreadContexts.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DriveDirectory.DriveDirectory, drives),
        Layer.succeed(UserDrives.UserDrives, {
          userId: Effect.succeed(actor.userId),
          contextIds: Effect.succeed(actor.contextIds),
          drives: Effect.succeed([]),
          changes: Stream.empty,
          changed: Stream.empty,
          access: (id) =>
            id.startsWith("my/")
              ? Effect.succeed("owner" as const)
              : drives.forDrive(id).role(actor.userId),
        }),
        Layer.succeed(UserFolders.UserFolders, {
          ...folders,
          turn: () =>
            Effect.succeed({
              pools: { top: PERSONAL_POOL_ID, projects: {} },
              instructions: { top: [], projects: {} },
              secrets: { top: [], projects: {} },
            }),
        }),
      ),
    ),
  );
  const service = yield* Threads.Threads.pipe(
    Effect.provide(
      ThreadsLive.layer.pipe(
        Layer.provide(contexts),
        Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, directory)),
        Layer.provide(ThreadKindTurns.layerNone),
        Layer.provide(Platform.layerCrypto),
        Layer.provide(layerAttachments(makeMemoryObjects())),
      ),
    ),
  );
  const launch = (project = projectId) =>
    service.launch(actor, {
      commandId: CommandId.make("launch"),
      threadId,
      projectId: project,
      title: "Work",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    });
  const send = (id: string) =>
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
  const subscribe = (afterSequence?: number) =>
    service
      .subscribe(actor, {
        threadId,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        requestCompletionMarker: true,
      })
      .pipe(
        Stream.flattenIterable,
        Stream.takeUntil((item) => item.kind === "synchronized"),
        Stream.runCollect,
      );
  return {
    service,
    launch,
    send,
    subscribe,
    calls,
    reset: () => {
      for (const key of Object.keys(calls)) Reflect.set(calls, key, 0);
    },
    publish: drives
      .forDrive(driveId)
      .setRemote({ provider: "github", repository: "owner/repo", defaultBranch: "main" }),
  };
});

describe("thread workspace reads", () => {
  it.effect(
    "never fetches full projections or rechecks drive state on an adopted thread's send and resubscribe",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.publish;
        yield* f.launch();
        f.reset();
        yield* f.send("next");
        expect(f.calls).toEqual({
          snapshot: 0,
          workspace: 1,
          dispatch: 1,
          subscribe: 0,
          remote: 0,
          role: 0,
        });
        f.reset();
        const items = yield* f.subscribe();
        expect(items.filter((item) => item.kind === "snapshot")).toHaveLength(1);
        expect(f.calls).toEqual({
          snapshot: 0,
          workspace: 1,
          dispatch: 0,
          subscribe: 1,
          remote: 0,
          role: 0,
        });
      }),
  );

  it.effect(
    "checks an unpublished drive freshly without reading its role or fetching a projection",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.launch();
        for (const id of ["first", "second"]) {
          f.reset();
          yield* f.send(id);
          expect(f.calls).toEqual({
            snapshot: 0,
            workspace: 1,
            dispatch: 1,
            subscribe: 0,
            remote: 1,
            role: 0,
          });
        }
        f.reset();
        yield* f.subscribe();
        expect(f.calls).toEqual({
          snapshot: 0,
          workspace: 1,
          dispatch: 0,
          subscribe: 1,
          remote: 1,
          role: 0,
        });
      }),
  );

  it.effect(
    "adopts immediately when resubscribing after publication, without preliminary full projections",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.launch();
        yield* f.publish;
        f.reset();
        const items = yield* f.subscribe();
        const snapshot = items.find((item) => item.kind === "snapshot");
        const expected = remoteThreadWorktree(driveId, threadId);
        expect(snapshot?.projection.thread).toMatchObject({
          branch: expected.branch,
          worktreePath: expected.path,
        });
        expect(f.calls).toEqual({
          snapshot: 0,
          workspace: 1,
          dispatch: 1,
          subscribe: 1,
          remote: 1,
          role: 1,
        });
      }),
  );

  it.effect("adopts on the next turn with zero full projections", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.launch();
      yield* f.publish;
      f.reset();
      yield* f.send("after-publication");
      expect(f.calls).toEqual({
        snapshot: 0,
        workspace: 1,
        dispatch: 2,
        subscribe: 0,
        remote: 1,
        role: 1,
      });
      expect((yield* f.service.snapshot(actor, threadId)).projection.thread.branch).toBe(
        remoteThreadWorktree(driveId, threadId).branch,
      );
    }),
  );

  it.effect(
    "replays publication adoption immediately when the UI resubscribes with its previous cursor",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.launch();
        const first = (yield* f.subscribe()).find((item) => item.kind === "snapshot");
        if (first === undefined) throw new Error("expected the initial subscription snapshot");
        yield* f.publish;
        f.reset();
        const replay = yield* f.subscribe(first.snapshotSequence);
        expect(replay.filter((item) => item.kind === "snapshot")).toEqual([]);
        const event = replay.find((item) => item.kind === "event");
        expect(event?.event).toMatchObject({
          type: "thread.metadata-updated",
          payload: {
            branch: remoteThreadWorktree(driveId, threadId).branch,
            worktreePath: remoteThreadWorktree(driveId, threadId).path,
          },
        });
        expect(f.calls).toEqual({
          snapshot: 0,
          workspace: 1,
          dispatch: 1,
          subscribe: 1,
          remote: 1,
          role: 1,
        });
      }),
  );

  it.effect(
    "reuses a requested snapshot and only rereads it when adoption changed the projection",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.launch();
        f.reset();
        expect((yield* f.service.snapshot(actor, threadId)).projection.thread.branch).toBeNull();
        expect(f.calls).toEqual({
          snapshot: 1,
          workspace: 0,
          dispatch: 0,
          subscribe: 0,
          remote: 1,
          role: 0,
        });
        yield* f.publish;
        f.reset();
        expect((yield* f.service.snapshot(actor, threadId)).projection.thread.branch).toBe(
          remoteThreadWorktree(driveId, threadId).branch,
        );
        expect(f.calls).toEqual({
          snapshot: 2,
          workspace: 0,
          dispatch: 1,
          subscribe: 0,
          remote: 1,
          role: 1,
        });
        f.reset();
        yield* f.service.snapshot(actor, threadId);
        expect(f.calls).toEqual({
          snapshot: 1,
          workspace: 0,
          dispatch: 0,
          subscribe: 0,
          remote: 0,
          role: 0,
        });
      }),
  );

  it.effect("skips drive lookups for My Drive and preserves workspace visibility checks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.launch(ProjectId.make("scratch"));
      f.reset();
      yield* f.service.refreshRemoteWorkspace(actor, threadId);
      expect(f.calls).toEqual({
        snapshot: 0,
        workspace: 1,
        dispatch: 0,
        subscribe: 0,
        remote: 0,
        role: 0,
      });
      f.reset();
      expect(
        (yield* Effect.flip(
          f.service.refreshRemoteWorkspace({ ...actor, userId: "stranger" }, threadId),
        ))._tag,
      ).toBe("ThreadNotFoundError");
      expect(f.calls).toEqual({
        snapshot: 0,
        workspace: 1,
        dispatch: 0,
        subscribe: 0,
        remote: 0,
        role: 0,
      });
    }),
  );
});
