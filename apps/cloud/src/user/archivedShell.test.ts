import {
  CommandId,
  MessageId,
  type OrchestrationV2ArchivedShellStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as Environment from "../environment.ts";
import { makeMemoryCloud } from "../testing.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { UserShell } from "./UserShell.ts";
import { projectIdForContext } from "./contextProjects.ts";

const userId = "user_1";
const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("archived-thread");

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
  const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(userId)));
  const shell = yield* UserShell.pipe(Effect.provide(cloud.layerFor(userId)));
  yield* threads.launchThread(actor, {
    commandId: CommandId.make("launch"),
    threadId,
    projectId: Environment.SCRATCH_PROJECT_ID,
    title: "Retained work",
    modelSelection: scriptedModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { messageId: MessageId.make("m1"), text: "Hello", attachments: [] },
  });
  yield* cloud.settle;
  yield* threads.dispatchCommand(actor, {
    type: "thread.archive",
    commandId: CommandId.make("archive"),
    threadId,
  });
  yield* cloud.settle;
  return { cloud, threads, shell };
});

describe("cloud archived shell", () => {
  it.effect("drops archived rows and projects when current context access is revoked", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const user = cloud.userDirectory.forUser(userId);
      const contextId = SignalboxContextId.make("org_archives");
      yield* user.recordSignIn({ id: userId, email: "a@b.c" });
      yield* user.syncOrganizations([{ id: contextId, name: "Archives" }]);
      const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(userId)));
      const shell = yield* UserShell.pipe(Effect.provide(cloud.layerFor(userId)));
      const member = { userId, contextIds: [contextId] };
      yield* threads.launchThread(member, {
        commandId: CommandId.make("launch-org"),
        threadId,
        projectId: projectIdForContext(contextId),
        title: "Private archive",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      yield* threads.dispatchCommand(member, {
        type: "thread.archive",
        commandId: CommandId.make("archive-org"),
        threadId,
      });
      yield* cloud.settle;
      const stream = yield* shell.subscribeArchived;
      const watching = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* user.syncOrganizations([]);
      const items = yield* Fiber.join(watching);
      expect(items[0]).toMatchObject({
        kind: "snapshot",
        snapshot: { threads: [{ id: threadId }] },
      });
      expect(items[1]).toMatchObject({ kind: "snapshot", snapshot: { threads: [] } });
      if (items[1]?.kind !== "snapshot") throw new Error("expected revoked snapshot");
      expect(
        items[1].snapshot.projects.some((project) => project.id === projectIdForContext(contextId)),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "streams retained archived rows, removes reopened work and replays a fresh snapshot",
    () =>
      Effect.gen(function* () {
        const { cloud, threads, shell } = yield* setup;
        const before = yield* threads.threadSnapshot(actor, threadId);
        const stream = yield* shell.subscribeArchived;
        const watching = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* threads.dispatchCommand(actor, {
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive"),
          threadId,
        });
        yield* cloud.settle;
        const items = yield* Fiber.join(watching);
        expect(items[0]?.kind).toBe("snapshot");
        if (items[0]?.kind !== "snapshot") throw new Error("expected archived snapshot");
        expect(items[0].snapshot.threads.map((thread) => thread.id)).toEqual([threadId]);
        expect(items[1]).toMatchObject({ kind: "thread.removed", threadId });
        const after = yield* threads.threadSnapshot(actor, threadId);
        expect(after.projection.messages).toEqual(before.projection.messages);
        expect(after.projection.providerThreads).toEqual(before.projection.providerThreads);
        expect(after.projection.checkpoints).toEqual(before.projection.checkpoints);
        const [reconnected] = yield* (yield* shell.subscribeArchived).pipe(
          Stream.take(1),
          Stream.runCollect,
        );
        expect(reconnected).toMatchObject({ kind: "snapshot", snapshot: { threads: [] } });
      }).pipe(Effect.scoped),
  );

  it.effect("a new message reopens an archived conversation without losing its history", () =>
    Effect.gen(function* () {
      const { cloud, threads, shell } = yield* setup;
      const before = yield* threads.threadSnapshot(actor, threadId);
      const stream = yield* shell.subscribeArchived;
      const watching = yield* stream.pipe(
        Stream.takeUntil((item) => item.kind === "thread.removed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* threads.dispatchCommand(actor, {
        type: "message.dispatch",
        commandId: CommandId.make("reopen-message"),
        threadId,
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("m2"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      yield* cloud.settle;
      const items: ReadonlyArray<OrchestrationV2ArchivedShellStreamItem> =
        yield* Fiber.join(watching);
      expect(items.at(-1)).toMatchObject({ kind: "thread.removed", threadId });
      const after = yield* threads.threadSnapshot(actor, threadId);
      expect(after.projection.thread.archivedAt).toBeNull();
      expect(after.projection.messages.slice(0, before.projection.messages.length)).toEqual(
        before.projection.messages,
      );
      expect(after.projection.messages.some((message) => message.id === "m2")).toBe(true);
    }).pipe(Effect.scoped),
  );
});
