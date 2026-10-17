import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId, type ProjectId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeMemoryCloud } from "../testing.ts";
import { SCRATCH_PROJECT_ID } from "../environment.ts";
import { CloudThreadService } from "../thread/CloudThreadService.ts";
import { ThreadCommandRejectedError } from "../thread/ThreadEngine.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";
import { projectIdForContext } from "../user/contextProjects.ts";
import { UserFolders } from "../user/UserFolders.ts";
import { make } from "./CloudCollaboration.ts";
import { wire } from "../thread/threadWire.ts";

const source = ThreadId.make("source");
const target = ThreadId.make("target");
const userId = "user_1";

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  const user = cloud.userDirectory.forUser(userId);
  yield* user.recordSignIn({ id: userId, email: "a@b.c" });
  const threads = yield* CloudThreadService.pipe(Effect.provide(cloud.layerFor(userId)));
  const service = yield* make.pipe(Effect.provide(cloud.layerFor(userId)));
  const launch = (id: ThreadId, owner = userId, projectId: ProjectId = SCRATCH_PROJECT_ID) =>
    Effect.gen(function* () {
      const contextIds = yield* cloud.userDirectory.forUser(owner).contextIds();
      return yield* CloudThreadService.use((service) =>
        service.launchThread(
          { userId: owner, contextIds },
          {
            commandId: CommandId.make(`launch:${id}`),
            threadId: id,
            projectId,
            title: `Thread ${id}`,
            modelSelection: scriptedModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          },
        ),
      ).pipe(Effect.provide(cloud.layerFor(owner)));
    });
  yield* launch(source);
  yield* launch(target);
  yield* cloud.settle;
  return { cloud, user, threads, service, launch };
});

describe("cloud thread collaboration", () => {
  it.effect("lists, reads, sends and pages meaningful history items without repeating a send", () =>
    Effect.gen(function* () {
      const { cloud, service } = yield* setup;
      expect(
        (yield* service.list(source, {})).threads.map((thread) => thread.threadId).toSorted(),
      ).toEqual([source, target]);
      const sent = yield* service.send(source, {
        threadId: target,
        message: "Hello other agent",
        clientRequestId: "one",
      });
      yield* cloud.settle;
      const repeated = yield* service.send(source, {
        threadId: target,
        message: "Hello other agent",
        clientRequestId: "one",
      });
      expect(repeated.runId).toBe(sent.runId);
      const first = yield* service.read(source, { threadId: target, limit: 1, maxCharsPerItem: 5 });
      expect(first.items[0]?.text).toBe("Hello");
      expect(first.items[0]?.textTruncated).toBe(true);
      expect(first.hasMore).toBe(true);
      const chunk = yield* service.read(source, {
        threadId: target,
        itemId: first.items[0]!.itemId,
        textOffset: first.items[0]!.nextTextOffset!,
        maxCharsPerItem: 50,
      });
      expect(chunk.items[0]?.text).toBe(" other agent");
      const second = yield* service.read(source, {
        threadId: target,
        afterPosition: first.nextPosition!,
        limit: 1,
      });
      expect(second.items[0]?.type).toBe("assistant_message");
      expect(second.items[0]?.position).toBeGreaterThan(first.items[0]!.position);
      expect(second.hasMore).toBe(false);
      expect((yield* service.read(source, { threadId: target })).recentRuns).toHaveLength(1);
      expect(yield* service.wait(source, { threadId: target, runId: sent.runId })).toMatchObject({
        runId: sent.runId,
        status: "completed",
        timedOut: false,
      });
    }),
  );

  it.effect("never reads, lists or sends to another person's private thread", () =>
    Effect.gen(function* () {
      const { cloud, service, launch } = yield* setup;
      yield* cloud.userDirectory
        .forUser("user_2")
        .recordSignIn({ id: "user_2", email: "other@b.c" });
      const privateId = ThreadId.make("private-other-person");
      yield* launch(privateId, "user_2");
      yield* cloud.settle;
      for (const operation of [
        Effect.asVoid(service.read(source, { threadId: privateId })),
        Effect.asVoid(service.send(source, { threadId: privateId, message: "Must not arrive" })),
        Effect.asVoid(service.wait(source, { threadId: privateId })),
        Effect.asVoid(service.read(privateId, { threadId: source })),
      ]) {
        const result = yield* Effect.result(Effect.asVoid(operation));
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "thread_not_found" } });
      }
      expect(
        (yield* service.list(source, {})).threads.map((thread) => thread.threadId),
      ).not.toContain(privateId);
      const untouched = yield* cloud.threadDirectory
        .forThread(privateId)
        .snapshot({ userId: "user_2", contextIds: [PERSONAL_CONTEXT_ID] });
      expect(untouched.projection.messages).toHaveLength(0);
    }),
  );

  it.effect("doesn't borrow a person's unrelated owner tree", () =>
    Effect.gen(function* () {
      const { service, launch, user } = yield* setup;
      yield* user.syncOrganizations([{ id: "org_acme", name: "Acme" }]);
      const work = ThreadId.make("work");
      yield* launch(work, userId, projectIdForContext(SignalboxContextId.make("org_acme")));
      expect(yield* Effect.result(service.read(source, { threadId: work }))).toMatchObject({
        _tag: "Failure",
        failure: { code: "thread_not_found" },
      });
      expect(
        yield* Effect.result(
          service.send(work, { threadId: target, message: "No personal borrowing" }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "thread_not_found" } });
      yield* user.syncOrganizations([]);
      expect(yield* Effect.result(service.read(work, { threadId: work }))).toMatchObject({
        _tag: "Failure",
        failure: { code: "thread_not_found" },
      });
    }),
  );

  it.effect(
    "delegates once, inherits the exact home before the first turn, and keeps the original result",
    () =>
      Effect.gen(function* () {
        const { cloud, service } = yield* setup;
        const folders = yield* UserFolders.pipe(Effect.provide(cloud.layerFor(userId)));
        const created = yield* folders.create({ name: "Owned work", parentId: null });
        const folderId = created.folders.find((folder) => folder.name === "Owned work")!.id;
        yield* folders.setInstructions({
          level: { _tag: "folder", folderId },
          instructions: "Only this folder's instructions",
        });
        yield* folders.moveThread({ threadId: source, folderId });
        const task = yield* service.delegate(source, {
          task: "Return the child result",
          clientRequestId: "child-one",
        });
        const retry = yield* service.delegate(source, {
          task: "Return the child result",
          clientRequestId: "child-one",
        });
        expect(retry.taskId).toBe(task.taskId);
        const child = yield* service.read(source, { threadId: task.childThreadId });
        expect(child.thread.parentThreadId).toBe(source);
        expect(child.thread.relationshipToParent).toBe("subagent");
        expect((yield* folders.threadHome(task.childThreadId)).home).toBe(folderId);
        const instructions = yield* cloud.runInstructions(task.childThreadId, task.childRunId!);
        expect(JSON.stringify(instructions)).toContain("Only this folder's instructions");
        expect(child.items.map((item) => item.text)).toEqual(["Return the child result"]);
        yield* cloud.settle;
        const completed = yield* service.status(source, { taskId: task.taskId });
        expect(completed.status).toBe("completed");
        expect(completed.summary).toContain("Return the child result");
        expect(
          (yield* service.delegate(source, {
            task: "Return the child result",
            clientRequestId: "child-one",
          })).childRunId,
        ).toBe(completed.childRunId);
        const notifications = (yield* service.read(source, { threadId: source })).items.filter(
          (item) => item.text?.startsWith("Child task cloud-task:"),
        );
        expect(notifications).toHaveLength(1);
        // The event outbox is at least once; replaying it must not wake the parent twice.
        const events = yield* cloud.threadEvents(task.childThreadId);
        yield* cloud.userDirectory.forUser(userId).threadEvents({
          threadId: task.childThreadId,
          events: wire.events.encode(
            events.map((event, index) => ({ event, sequence: index + 1 })),
          ),
        });
        expect(
          (yield* service.read(source, { threadId: source })).items.filter((item) =>
            item.text?.startsWith("Child task cloud-task:"),
          ),
        ).toHaveLength(1);
        yield* service.send(source, {
          threadId: task.childThreadId,
          message: "A different later turn",
        });
        yield* cloud.settle;
        const later = yield* service.status(source, { taskId: task.taskId });
        expect(later.childRunId).toBe(completed.childRunId);
        expect(later.summary).toBe(completed.summary);
        expect(later.latestTerminalRunId).not.toBe(completed.childRunId);
        expect(yield* Effect.result(service.status(target, { taskId: task.taskId }))).toMatchObject(
          { _tag: "Failure", failure: { code: "task_not_found" } },
        );
      }),
  );

  it.effect("waits on committed events, and a wait timeout never cancels the run", () =>
    Effect.gen(function* () {
      const { cloud, service, threads } = yield* setup;
      const started = yield* service.send(source, { threadId: target, message: "Still running" });
      const subscribed = yield* Deferred.make<void>();
      const watched = yield* make.pipe(
        Effect.provideService(CloudThreadService, {
          ...threads,
          subscribeThread: (actor, input) =>
            threads
              .subscribeThread(actor, input)
              .pipe(Stream.tap(() => Deferred.succeed(subscribed, undefined))),
        }),
        Effect.provide(cloud.layerFor(userId)),
      );
      const waiting = yield* watched
        .wait(source, { threadId: target, runId: started.runId, timeoutMs: 500 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      yield* TestClock.adjust(500);
      expect(yield* Fiber.join(waiting)).toMatchObject({ timedOut: true, runId: started.runId });
      expect((yield* service.read(source, { threadId: target })).recentRuns[0]?.status).toBe(
        "starting",
      );
      const again = yield* Deferred.make<void>();
      const live = yield* make.pipe(
        Effect.provideService(CloudThreadService, {
          ...threads,
          subscribeThread: (actor, input) =>
            threads
              .subscribeThread(actor, input)
              .pipe(Stream.tap(() => Deferred.succeed(again, undefined))),
        }),
        Effect.provide(cloud.layerFor(userId)),
      );
      const finished = yield* live
        .wait(source, { threadId: target, runId: started.runId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(again);
      yield* cloud.settle;
      expect(yield* Fiber.join(finished)).toMatchObject({ timedOut: false, status: "completed" });
    }),
  );

  it.effect("task cancellation stops queued and active child work without waking its parent", () =>
    Effect.gen(function* () {
      const { cloud, service } = yield* setup;
      const request = { task: "Stop this child", clientRequestId: "cancelled-child" };
      const task = yield* service.delegate(source, request);
      const parentBefore = yield* service.read(source, { threadId: source });
      yield* service.send(source, {
        threadId: task.childThreadId,
        message: "Queued work",
        mode: "queue",
      });
      yield* service.cancel(source, { taskId: task.taskId, clientRequestId: "cancel-one" });
      yield* cloud.settle;
      const child = yield* service.read(source, { threadId: task.childThreadId });
      expect(child.recentRuns.map((run) => run.status)).toEqual(["cancelled", "interrupted"]);
      expect((yield* service.status(source, { taskId: task.taskId })).status).toBe("interrupted");
      expect((yield* service.delegate(source, request)).status).toBe("interrupted");
      yield* cloud.settle;
      const parentAfter = yield* service.read(source, { threadId: source });
      expect(parentAfter.items).toEqual(parentBefore.items);
      expect(parentAfter.recentRuns).toEqual(parentBefore.recentRuns);
    }),
  );

  it.effect("a root Stop cancels queued and active child and grandchild runs", () =>
    Effect.gen(function* () {
      const { cloud, service, threads } = yield* setup;
      const rootRun = yield* service.send(source, { threadId: source, message: "Parent work" });
      const child = yield* service.delegate(source, { task: "Child work" });
      yield* service.send(source, {
        threadId: child.childThreadId,
        message: "Queued child work",
        mode: "queue",
      });
      const grandchild = yield* service.delegate(child.childThreadId, { task: "Nested work" });
      yield* service.send(child.childThreadId, {
        threadId: grandchild.childThreadId,
        message: "Queued grandchild work",
        mode: "queue",
      });

      // A person's Stop must still revoke children started before the parent's modes changed.
      yield* threads.dispatchCommand(
        { userId, contextIds: [PERSONAL_CONTEXT_ID] },
        {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("parent-enters-plan"),
          threadId: source,
          interactionMode: "plan",
        },
      );
      yield* threads.dispatchCommand(
        { userId, contextIds: [PERSONAL_CONTEXT_ID] },
        {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("parent-lowers-runtime-mode"),
          threadId: source,
          runtimeMode: "approval-required",
        },
      );

      yield* threads.dispatchCommand(
        { userId, contextIds: [PERSONAL_CONTEXT_ID] },
        {
          type: "run.interrupt",
          commandId: CommandId.make("stop-root-parent"),
          threadId: source,
          runId: rootRun.runId,
        },
      );
      yield* cloud.settle;

      expect(
        (yield* service.read(source, { threadId: child.childThreadId })).recentRuns.map(
          (run) => run.status,
        ),
      ).toEqual(["cancelled", "interrupted"]);
      const childEvents = yield* cloud.threadEvents(child.childThreadId);
      const queuedCancellation = childEvents.findIndex(
        (event) =>
          event.type === "run.updated" &&
          event.payload.ordinal === 2 &&
          event.payload.status === "cancelled",
      );
      const activeInterruption = childEvents.findIndex(
        (event) =>
          event.type === "run.updated" &&
          event.payload.ordinal === 1 &&
          event.payload.status === "interrupted",
      );
      expect(queuedCancellation).toBeGreaterThanOrEqual(0);
      expect(queuedCancellation).toBeLessThan(activeInterruption);
      expect(
        (yield* service.read(source, { threadId: grandchild.childThreadId })).recentRuns.map(
          (run) => run.status,
        ),
      ).toEqual(["cancelled", "interrupted"]);
      const parent = yield* service.read(source, { threadId: source });
      expect(parent.recentRuns.map((run) => run.status)).toEqual(["interrupted"]);
      expect(parent.items.some((item) => item.text?.startsWith("Child task cloud-task:"))).toBe(
        false,
      );
    }),
  );

  it.effect("replaying an old root Stop leaves a later turn's child work available", () =>
    Effect.gen(function* () {
      const { cloud, service, threads } = yield* setup;
      const firstRun = yield* service.send(source, { threadId: source, message: "First turn" });
      const firstChild = yield* service.delegate(source, { task: "First child" });
      yield* threads.dispatchCommand(
        { userId, contextIds: [PERSONAL_CONTEXT_ID] },
        {
          type: "run.interrupt",
          commandId: CommandId.make("stop-first-parent-turn"),
          threadId: source,
          runId: firstRun.runId,
        },
      );
      expect(
        yield* Effect.result(service.delegate(source, { task: "Late first-turn child" })),
      ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });

      const secondRun = yield* service.send(source, { threadId: source, message: "Second turn" });
      const secondChild = yield* service.delegate(source, { task: "Second child" });
      const oldEvents = yield* cloud.threadEvents(source);
      yield* cloud.settle;

      const first = yield* service.read(source, { threadId: firstChild.childThreadId });
      const second = yield* service.read(source, { threadId: secondChild.childThreadId });
      expect(first.recentRuns[0]?.status).toBe("interrupted");
      expect(second.recentRuns[0]?.status).not.toBe("cancelled");
      expect(second.recentRuns[0]?.status).not.toBe("interrupted");
      expect(secondRun.runId).not.toBe(firstRun.runId);
      const parentBeforeReplay = yield* service.read(source, { threadId: source });

      yield* cloud.userDirectory.forUser(userId).threadEvents({
        threadId: source,
        events: wire.events.encode(
          oldEvents.map((event, index) => ({ event, sequence: index + 1 })),
        ),
      });

      const parentAfterReplay = yield* service.read(source, { threadId: source });
      expect(parentAfterReplay.items).toEqual(parentBeforeReplay.items);
      expect(parentAfterReplay.recentRuns).toEqual(parentBeforeReplay.recentRuns);
      expect(
        parentAfterReplay.items.some((item) =>
          item.text?.startsWith(`Child task cloud-task:${firstChild.childThreadId}`),
        ),
      ).toBe(false);
      expect((yield* service.status(source, { taskId: secondChild.taskId })).status).not.toBe(
        "interrupted",
      );
    }),
  );

  it.effect(
    "cancels nested children and rejects a late result that would revive their parent",
    () =>
      Effect.gen(function* () {
        const { cloud, service, threads } = yield* setup;
        const child = yield* service.delegate(source, { task: "Child work" });
        const unavailable = yield* make.pipe(
          Effect.provideService(CloudThreadService, {
            ...threads,
            launchThread: () =>
              Effect.fail(
                new ThreadCommandRejectedError({
                  commandId: "failed-launch",
                  commandType: "thread.launch",
                  reason: "Pool unavailable",
                }),
              ),
          }),
          Effect.provide(cloud.layerFor(userId)),
        );
        expect(
          yield* Effect.result(
            unavailable.delegate(child.childThreadId, { task: "Failed launch" }),
          ),
        ).toMatchObject({
          _tag: "Failure",
        });
        const grandchild = yield* service.delegate(child.childThreadId, { task: "Nested work" });
        // Rebuild the service to prove the task graph is durable, not a sidebar cache.
        const restarted = yield* make.pipe(Effect.provide(cloud.layerFor(userId)));
        yield* restarted.cancel(source, { taskId: child.taskId });
        expect(
          yield* Effect.result(restarted.delegate(child.childThreadId, { task: "Too late" })),
        ).toMatchObject({
          _tag: "Failure",
          failure: { code: "invalid_request" },
        });
        yield* cloud.settle;
        const stopped = yield* service.read(source, { threadId: child.childThreadId });
        expect(stopped.recentRuns).toHaveLength(1);
        expect(stopped.recentRuns[0]?.status).toBe("interrupted");
        expect(
          (yield* service.status(child.childThreadId, { taskId: grandchild.taskId })).status,
        ).toBe("interrupted");
        const events = yield* cloud.threadEvents(grandchild.childThreadId);
        yield* cloud.userDirectory.forUser(userId).threadEvents({
          threadId: grandchild.childThreadId,
          events: wire.events.encode(
            events.map((event, index) => ({ event, sequence: index + 1 })),
          ),
        });
        expect(
          (yield* service.read(source, { threadId: child.childThreadId })).recentRuns,
        ).toHaveLength(1);
      }),
  );

  it.effect("checks a result's observed parent run atomically with the delivery command", () =>
    Effect.gen(function* () {
      const { cloud, service, threads } = yield* setup;
      const sent = yield* service.send(source, { threadId: target, message: "Work to stop" });
      const actor = { userId, contextIds: [PERSONAL_CONTEXT_ID] };
      const before = yield* threads.threadSnapshot(actor, target);
      const run = before.projection.runs.find((candidate) => candidate.id === sent.runId)!;
      yield* service.interrupt(source, { threadId: target, runId: run.id });
      expect(
        yield* Effect.result(
          threads.dispatchCommand(
            actor,
            {
              type: "message.dispatch",
              commandId: CommandId.make("late-result"),
              messageId: MessageId.make("late-result"),
              threadId: target,
              text: "Must not restart this thread",
              attachments: [],
              createdBy: "agent",
              creationSource: "mcp",
              dispatchMode: { type: "queue_after_active" },
            },
            run,
          ),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadCommandRejectedError" } });
      yield* cloud.settle;
      const stopped = yield* service.read(source, { threadId: target });
      expect(stopped.recentRuns).toHaveLength(1);
      expect(stopped.recentRuns[0]?.status).toBe("interrupted");
    }),
  );

  it.effect("ends an in-flight wait when organization access is revoked", () =>
    Effect.gen(function* () {
      const { cloud, service, threads, user, launch } = yield* setup;
      yield* user.syncOrganizations([{ id: "org_acme", name: "Acme" }]);
      const project = projectIdForContext(SignalboxContextId.make("org_acme"));
      const workSource = ThreadId.make("work-source");
      const workTarget = ThreadId.make("work-target");
      yield* launch(workSource, userId, project);
      yield* launch(workTarget, userId, project);
      const sent = yield* service.send(workSource, {
        threadId: workTarget,
        message: "Wait until revoked",
      });
      const subscribed = yield* Deferred.make<void>();
      const watched = yield* make.pipe(
        Effect.provideService(CloudThreadService, {
          ...threads,
          subscribeThread: (actor, input) =>
            threads
              .subscribeThread(actor, input)
              .pipe(Stream.tap(() => Deferred.succeed(subscribed, undefined))),
        }),
        Effect.provide(cloud.layerFor(userId)),
      );
      const waiting = yield* watched
        .wait(workSource, { threadId: workTarget, runId: sent.runId })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(subscribed);
      yield* user.syncOrganizations([]);
      expect(yield* Fiber.join(waiting)).toMatchObject({
        _tag: "Failure",
        failure: { code: "thread_not_found" },
      });
    }),
  );
});
