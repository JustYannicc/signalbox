// @effect-diagnostics nodeBuiltinImport:off - the eviction tests need a database file that outlives one engine.
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadStreamItem,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";

import { layerThreadObject } from "../testing.ts";
import { remoteThreadWorktree } from "../user/contextProjects.ts";
import { scriptedModelSelection, scriptedReply } from "./scriptedProvider.ts";
import { applyEvents } from "./threadProjection.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const stranger = { userId: "user_2", contextIds: [PERSONAL_CONTEXT_ID] };
const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};
const threadId = ThreadId.make("thread-1");

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

/** A fresh database file; each `withObject` on it is the object waking up again. */
const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-object-"));
  directories.push(directory);
  return NodePath.join(directory, "thread.sqlite");
};

const withObject = <A, E>(
  filename: string,
  use: (
    engine: ThreadEngine.ThreadEngine["Service"],
    store: ThreadStore.ThreadStore["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(filename)).pipe(
      Effect.flatMap((context) =>
        use(
          Context.get(context, ThreadEngine.ThreadEngine),
          Context.get(context, ThreadStore.ThreadStore),
        ),
      ),
    ),
  );

const launch = (engine: ThreadEngine.ThreadEngine["Service"], text = "Hello cloud") =>
  engine.launch(
    owner,
    {
      commandId: CommandId.make("launch-1"),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Hello cloud",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make("message-1"), text, attachments: [] },
    },
    personal,
  );

const send = (
  commandId: string,
  text: string,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(commandId),
  createdBy: "user",
  creationSource: "web",
  threadId,
  messageId: MessageId.make(`message-${commandId}`),
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  deliveryIntent: "auto",
});

const runToIdle = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    for (let steps = 0; steps < 200; steps++) {
      if (!(yield* engine.step)) return steps;
    }
    throw new Error("the scripted turn never settled");
  });

const assistantTexts = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.snapshot(owner), ({ projection }) =>
    projection.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text),
  );

/** Every event after `cursor`, the way a resuming client asks for them. */
const replayFrom = (engine: ThreadEngine.ThreadEngine["Service"], afterSequence: number) =>
  Effect.scoped(
    Effect.flatMap(
      engine.subscribe(owner, { threadId, afterSequence, requestCompletionMarker: true }),
      (stream) =>
        stream.pipe(
          Stream.flattenIterable,
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        ),
    ),
  );

describe("ThreadEngine", () => {
  it.effect(
    "persists remote adoption across eviction without replacing a stopped thread's history or session",
    () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        const worktree = remoteThreadWorktree(personal.place.driveId, threadId);
        const previous = yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            const launched = yield* launch(engine);
            yield* engine.step;
            yield* engine.dispatch(
              owner,
              {
                type: "run.interrupt",
                commandId: CommandId.make("stop-for-publication"),
                threadId,
                runId: launched.projection.runs[0]!.id,
                holdQueue: true,
              },
              personal,
            );
            return yield* engine.snapshot(owner);
          }),
        );
        yield* withObject(filename, (engine, store) =>
          Effect.gen(function* () {
            const command = {
              type: "thread.metadata.update" as const,
              commandId: CommandId.make("adopt-remote"),
              threadId,
            };
            const before = yield* engine.snapshot(owner);
            const result = yield* engine.dispatch(owner, command, {
              ...personal,
              place: null,
              worktree,
            });
            expect(
              yield* engine.dispatch(owner, command, { ...personal, place: null, worktree }),
            ).toMatchObject({ sequence: result.sequence });
            const after = yield* engine.snapshot(owner);
            expect(after.snapshotSequence).toBe(before.snapshotSequence + 1);
            expect(after.projection.thread).toMatchObject({
              branch: worktree.branch,
              worktreePath: worktree.path,
            });
            expect(after.projection.runs).toEqual(previous.projection.runs);
            expect(after.projection.messages).toEqual(previous.projection.messages);
            expect(after.projection.providerThreads).toEqual(previous.projection.providerThreads);
            expect(after.projection.providerSessions).toEqual(previous.projection.providerSessions);
            expect((yield* store.owner)?.driveId).toBe(personal.place.driveId);
          }),
        );
        yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            expect((yield* engine.snapshot(owner)).projection.thread).toMatchObject({
              branch: worktree.branch,
              worktreePath: worktree.path,
            });
            yield* engine.dispatch(
              owner,
              send("continue-published", "Continue after publication"),
              personal,
            );
            yield* runToIdle(engine);
            const after = yield* engine.snapshot(owner);
            expect(after.projection.runs.map((run) => run.status)).toEqual([
              "interrupted",
              "completed",
            ]);
            expect(after.projection.thread.branch).toBe(worktree.branch);
          }),
        );
      }),
  );

  it.effect("refuses a trusted adoption aimed at another drive or a host directory", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const before = yield* engine.snapshot(owner);
        const error = yield* Effect.flip(
          engine.dispatch(
            owner,
            {
              type: "thread.metadata.update",
              commandId: CommandId.make("wrong-home"),
              threadId,
            },
            { ...personal, place: null, worktree: { branch: "main", path: "/tmp/host" } },
          ),
        );
        expect(error._tag).toBe("ThreadCommandRejectedError");
        expect(yield* engine.snapshot(owner)).toEqual(before);
      }),
    ),
  );

  it.effect("folds streaming into the final search row and keeps its Find anchor", () =>
    withObject(freshDatabase(), (engine, store) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* engine.step;
        const beforeChunk = (yield* store.searchOutbox).revision;
        yield* engine.step;
        expect((yield* store.searchOutbox).revision).toBe(beforeChunk);
        yield* runToIdle(engine);
        const documents = [];
        const parts = [];
        for (
          let delivery = yield* engine.pendingSearchDelivery;
          delivery !== null;
          delivery = yield* engine.pendingSearchDelivery
        ) {
          documents.push(...delivery.documents.filter((item) => item.kind === "assistant"));
          parts.push(...(delivery.parts ?? []).filter((item) => item.kind === "assistant"));
          yield* engine.acknowledgeSearchDelivery(delivery.revision, delivery.deliveryId);
        }
        expect(documents.length).toBe(0);
        expect(parts.map((item) => item.text).join("")).toBe(scriptedReply("Hello cloud"));
        const found = yield* engine.find(owner, { threadId, query: "Hello cloud" });
        expect(found.totalMatches).toBeGreaterThanOrEqual(2);
        expect(found.match?.entryId).toBe("message-1");
        const exact = yield* engine.searchDocuments(owner, [parts[0]!.itemId]);
        expect(exact?.documents).toHaveLength(1);
        expect(exact?.documents[0]).toMatchObject({
          itemId: parts[0]!.itemId,
          entryId: parts[0]!.entryId,
          text: scriptedReply("Hello cloud"),
        });
      }),
    ),
  );

  it.effect("launches a thread whose scripted reply streams in chunks and completes", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const launched = yield* launch(engine);
        expect(launched.resumed).toBe(false);
        expect(launched.projection.runs.map((run) => run.status)).toEqual(["starting"]);

        const steps = yield* runToIdle(engine);
        expect(steps).toBeGreaterThan(3);
        expect(yield* assistantTexts(engine)).toEqual([scriptedReply("Hello cloud")]);

        const { projection } = yield* engine.snapshot(owner);
        expect(projection.runs.map((run) => run.status)).toEqual(["completed"]);
        expect(projection.visibleTurnItems.map((row) => row.item.type)).toEqual([
          "user_message",
          "assistant_message",
        ]);
        const summary = yield* engine.summary(owner);
        expect(summary?.shell.status).toBe("completed");
        expect(summary?.shell.latestUserMessageAt).not.toBeNull();
      }),
    ),
  );

  it.effect("keeps the run activity timer anchored through startup and reload", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const beforeReload = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          const launched = yield* launch(engine);
          const requestedAt = launched.projection.runs[0]?.requestedAt;
          if (requestedAt === undefined) throw new Error("launch did not create a run");

          yield* TestClock.adjust("35 seconds");
          yield* engine.step;

          const { projection } = yield* engine.snapshot(owner);
          const run = projection.runs[0];
          expect(run?.status).toBe("running");
          expect(run?.startedAt).not.toBeNull();
          expect(
            DateTime.toEpochMillis(run!.startedAt!) - DateTime.toEpochMillis(requestedAt),
          ).toBe(35_000);

          const summary = yield* engine.summary(owner);
          const activityStartedAt = summary?.shell.activityRunStartedAt;
          return {
            requestedAt: DateTime.toEpochMillis(requestedAt),
            activityStartedAt:
              activityStartedAt === null || activityStartedAt === undefined
                ? null
                : DateTime.toEpochMillis(activityStartedAt),
          };
        }),
      );
      const afterReload = yield* withObject(filename, (engine) => engine.summary(owner));
      const reloadedActivityStartedAt = afterReload?.shell.activityRunStartedAt;

      expect(beforeReload.activityStartedAt).toBe(beforeReload.requestedAt);
      expect(
        reloadedActivityStartedAt === null || reloadedActivityStartedAt === undefined
          ? null
          : DateTime.toEpochMillis(reloadedActivityStartedAt),
      ).toBe(beforeReload.requestedAt);
    }),
  );

  it.effect("returns the original result for a command id it has already decided", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const relaunched = yield* launch(engine);
        expect(relaunched.resumed).toBe(true);
        yield* runToIdle(engine);

        const first = yield* engine.dispatch(owner, send("send-2", "Again"), personal);
        const retried = yield* engine.dispatch(owner, send("send-2", "Again"), personal);
        expect(retried).toEqual(first);
        yield* runToIdle(engine);

        const { projection } = yield* engine.snapshot(owner);
        expect(projection.runs).toHaveLength(2);
        expect(projection.messages.filter((message) => message.role === "user")).toHaveLength(2);
      }),
    ),
  );

  it.effect("hides a trashed thread and restores its conversation", () =>
    withObject(freshDatabase(), (engine, store) =>
      Effect.gen(function* () {
        const original = yield* launch(engine);
        yield* engine.step;
        yield* engine.dispatch(owner, send("send-queued", "Next"), personal);
        const beforeTrash = yield* engine.snapshot(owner);
        expect(beforeTrash.projection.runs.map((run) => run.status)).toEqual(["running", "queued"]);
        for (
          let delivery = yield* engine.pendingSearchDelivery;
          delivery !== null;
          delivery = yield* engine.pendingSearchDelivery
        ) {
          yield* engine.acknowledgeSearchDelivery(delivery.revision, delivery.deliveryId);
        }
        const deletedAt = yield* Clock.currentTimeMillis;
        const input = {
          trashId: "trash-1",
          deletedAt,
          purgeAfter: deletedAt + 30 * 24 * 60 * 60 * 1000,
        };

        const trashed = yield* engine.trash(owner, input);
        expect(trashed).toMatchObject({ trashId: input.trashId, state: "trashed" });
        const searchTombstone = yield* engine.pendingSearchDelivery;
        expect(searchTombstone?.thread.deleted).toBe(true);
        if (searchTombstone === null) throw new Error("Trash must reach the search outbox.");
        yield* engine.acknowledgeSearchDelivery(
          searchTombstone.revision,
          searchTombstone.deliveryId,
        );
        expect(yield* engine.searchDocuments(owner, [])).toBeNull();
        expect(yield* engine.canSee(owner)).toBe(false);
        expect((yield* Effect.flip(engine.snapshot(owner)))._tag).toBe("ThreadNotFoundError");
        const refused = yield* Effect.flip(
          engine.dispatch(owner, send("send-hidden", "No"), personal),
        );
        expect(refused).toMatchObject({
          _tag: "ThreadCommandRejectedError",
          reason: "This thread is in Trash.",
        });
        expect(yield* engine.hasTurnWork).toBe(false);

        const eventCount = (yield* store.events(0)).length;
        expect(yield* engine.trash(owner, input)).toEqual(trashed);
        expect((yield* store.events(0)).length).toBe(eventCount);

        const restoredReceipt = yield* engine.restoreTrash(owner, input.trashId);
        expect(restoredReceipt.state).toBe("restored");
        expect((yield* engine.pendingSearchDelivery)?.thread.deleted).toBe(false);
        const searchable = yield* engine.searchDocuments(
          owner,
          beforeTrash.projection.visibleTurnItems.map((row) => String(row.item.id)),
        );
        expect(searchable?.deleted).toBe(false);
        expect(searchable?.documents.some((item) => item.text === "Hello cloud")).toBe(true);
        expect(yield* engine.canSee(owner)).toBe(true);
        const restored = yield* engine.snapshot(owner);
        expect(restored.projection.thread.deletedAt).toBeNull();
        expect(
          restored.projection.messages.some(
            (message) => message.role === "user" && message.text === "Next",
          ),
        ).toBe(true);
        expect(restored.projection.runs.map((run) => run.status)).toEqual([
          "interrupted",
          "queued",
        ]);
        expect(
          restored.projection.messages.some(
            (message) => message.id === original.projection.messages[0]?.id,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("refuses permanent cleanup and preserves the trashed conversation", () =>
    withObject(freshDatabase(), (engine, store) =>
      Effect.gen(function* () {
        const original = yield* launch(engine);
        const deletedAt = yield* Clock.currentTimeMillis;
        const input = {
          trashId: "trash-purge-disabled",
          deletedAt,
          purgeAfter: deletedAt + 30 * 24 * 60 * 60 * 1000,
        };
        yield* engine.trash(owner, input);
        const before = yield* store.currentTrash;
        const refusal = yield* Effect.flip(
          engine.purgeTrash(owner, { trashId: input.trashId, empty: true }),
        );
        expect(refusal).toMatchObject({
          _tag: "ThreadCommandRejectedError",
          reason: "Permanent thread cleanup is not enabled yet.",
        });
        expect(yield* store.currentTrash).toEqual(before);

        yield* engine.restoreTrash(owner, input.trashId);
        const restored = yield* engine.snapshot(owner);
        expect(restored.projection.messages).toEqual(original.projection.messages);
        expect(restored.projection.thread.deletedAt).toBeNull();
      }),
    ),
  );

  it.effect("remembers a rejection instead of deciding the command again", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const deferred: OrchestrationV2Command = {
          ...send("deferred", "Later"),
          dispatchMode: { type: "defer_start" },
        } as OrchestrationV2Command;
        const first = yield* Effect.flip(engine.dispatch(owner, deferred, personal));
        const second = yield* Effect.flip(engine.dispatch(owner, deferred, personal));
        expect(first._tag).toBe("ThreadCommandRejectedError");
        expect(second).toEqual(first);
      }),
    ),
  );

  it.effect("finishes a turn interrupted by eviction, and replays from any cursor", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      // Evicted partway through streaming the reply.
      yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          yield* launch(engine);
          for (let step = 0; step < 3; step++) yield* engine.step;
        }),
      );
      const log = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          expect(yield* engine.hasTurnWork).toBe(true);
          yield* runToIdle(engine);
          expect(yield* assistantTexts(engine)).toEqual([scriptedReply("Hello cloud")]);
          return yield* replayFrom(engine, 0);
        }),
      );
      // From zero the thread's creation is in range, so the client gets a snapshot.
      expect(log.map((item) => item.kind)).toEqual(["snapshot", "synchronized"]);
      const head = log[0]?.kind === "snapshot" ? log[0].snapshotSequence : 0;

      yield* withObject(filename, (engine, store) =>
        Effect.gen(function* () {
          const { projection } = yield* engine.snapshot(owner);
          for (let cursor = 1; cursor <= head; cursor++) {
            const replay = yield* replayFrom(engine, cursor);
            const events = replay.flatMap((item) => (item.kind === "event" ? [item] : []));
            // Nothing lost, nothing repeated: exactly the events after the cursor, in order.
            expect(events.map((item) => item.sequence)).toEqual(
              Array.from({ length: head - cursor }, (_, index) => cursor + index + 1),
            );
            expect(replay.at(-1)?.kind).toBe("synchronized");
          }
          // What a client held at any cursor, plus the replay after it, is the object's projection.
          const all = (yield* store.events(0)).map((stored) => stored.event);
          for (let cursor = 1; cursor <= head; cursor++) {
            const replay = yield* replayFrom(engine, cursor);
            const tail = replay.flatMap((item) => (item.kind === "event" ? [item.event] : []));
            expect(applyEvents(null, [...all.slice(0, cursor), ...tail])).toEqual(projection);
          }
        }),
      );
    }),
  );

  it.effect("streams each commit to subscribers as one batch after the catch-up", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const { snapshotSequence } = yield* engine.snapshot(owner);
        const received = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* engine.subscribe(owner, {
              threadId,
              afterSequence: snapshotSequence,
              requestCompletionMarker: true,
            });
            const collecting = yield* stream.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* engine.step;
            yield* engine.step;
            return yield* Fiber.join(collecting);
          }),
        );
        const [marker, starting, chunk] = received as ReadonlyArray<
          ReadonlyArray<OrchestrationV2ThreadStreamItem>
        >;
        expect(marker?.map((item) => item.kind)).toEqual(["synchronized"]);
        // The first step starts the run and streams the first chunk in one commit.
        expect(
          starting?.map((item) => (item.kind === "event" ? item.event.type : item.kind)),
        ).toEqual(["run.updated", "run-attempt.updated", "node.updated", "turn-item.updated"]);
        expect(chunk?.map((item) => (item.kind === "event" ? item.sequence : -1))).toEqual([
          snapshotSequence + 5,
        ]);
      }),
    ),
  );

  it.effect("starts a queued run's timer at activation and preserves it after reload", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const activation = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* engine.step;
          yield* engine.dispatch(owner, send("send-2", "Second"), personal);
          const queued = yield* engine.snapshot(owner);
          expect(queued.projection.runs.map((run) => run.status)).toEqual(["running", "queued"]);
          const queuedRun = queued.projection.runs[1]!;
          expect(queuedRun.workStartedAt).toBeUndefined();

          yield* TestClock.adjust("10 minutes");
          let activated:
            | { readonly requestedAt: number; readonly workStartedAt: number }
            | undefined;
          for (let steps = 0; steps < 200; steps++) {
            yield* engine.step;
            const { projection } = yield* engine.snapshot(owner);
            const run = projection.runs[1];
            if (run?.status === "starting" && run.startedAt === null && run.workStartedAt) {
              activated = {
                requestedAt: DateTime.toEpochMillis(queuedRun.requestedAt),
                workStartedAt: DateTime.toEpochMillis(run.workStartedAt),
              };
              break;
            }
          }
          if (activated === undefined) throw new Error("queued run was not activated");
          expect(activated.workStartedAt).toBeGreaterThan(activated.requestedAt);

          yield* TestClock.adjust("35 seconds");
          yield* engine.step;
          const started = yield* engine.snapshot(owner);
          const runningRun = started.projection.runs[1]!;
          expect(runningRun.status).toBe("running");
          expect(runningRun.startedAt).not.toBeNull();
          expect(DateTime.toEpochMillis(runningRun.workStartedAt!)).toBe(activated.workStartedAt);
          const runningSummary = yield* engine.summary(owner);
          expect(DateTime.toEpochMillis(runningSummary!.shell.activityRunStartedAt!)).toBe(
            activated.workStartedAt,
          );
          return activated;
        }),
      );
      const afterReload = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          const snapshot = yield* engine.snapshot(owner);
          expect(snapshot.projection.runs[1]?.status).toBe("running");
          const summary = yield* engine.summary(owner);
          const activityStartedAt = summary?.shell.activityRunStartedAt;
          expect(activityStartedAt).not.toBeNull();
          expect(DateTime.toEpochMillis(activityStartedAt!)).toBe(activation.workStartedAt);

          yield* runToIdle(engine);
          return yield* assistantTexts(engine);
        }),
      );
      expect(afterReload).toEqual([scriptedReply("Hello cloud"), scriptedReply("Second")]);
    }),
  );

  it.effect("preserves a notification wake's work start across reload", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const previousWorkStartedAt = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* engine.step;
          const first = (yield* engine.snapshot(owner)).projection.runs[0]!;
          const workStartedAt = first.workStartedAt;
          if (workStartedAt === undefined) throw new Error("first run has no work start");
          yield* runToIdle(engine);

          yield* TestClock.adjust("10 minutes");
          yield* engine.dispatch(
            owner,
            {
              ...send("wake", "Resume after background work"),
              createdBy: "agent",
              creationSource: "provider",
              notification: {
                source: { kind: "background_task" },
                outcome: "completed",
                summary: "Background work completed",
              },
            },
            personal,
          );
          const wake = (yield* engine.snapshot(owner)).projection.runs[1]!;
          expect(wake.status).toBe("starting");
          expect(wake.workStartedAt).toEqual(workStartedAt);
          return workStartedAt;
        }),
      );
      const afterReload = yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("35 seconds");
          yield* engine.step;
          const wake = (yield* engine.snapshot(owner)).projection.runs[1]!;
          expect(wake.status).toBe("running");
          expect(wake.startedAt).not.toBeNull();
          expect(wake.workStartedAt).toEqual(previousWorkStartedAt);
          const summary = yield* engine.summary(owner);
          return summary?.shell.activityRunStartedAt;
        }),
      );
      expect(afterReload).toEqual(previousWorkStartedAt);
    }),
  );

  it.effect("stops a turn, holds the queue, and resumes it on request", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const launched = yield* launch(engine);
        yield* engine.step;
        yield* engine.dispatch(owner, send("send-2", "Second"), personal);
        yield* engine.dispatch(
          owner,
          {
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: launched.projection.runs[0]!.id,
            holdQueue: true,
          },
          personal,
        );
        expect(yield* engine.hasTurnWork).toBe(false);
        const stopped = yield* engine.snapshot(owner);
        expect(stopped.projection.runs.map((run) => [run.status, run.queueHeld === true])).toEqual([
          ["interrupted", false],
          ["queued", true],
        ]);

        yield* engine.dispatch(
          owner,
          {
            type: "queue.resume",
            commandId: CommandId.make("resume"),
            threadId,
          },
          personal,
        );
        yield* runToIdle(engine);
        const resumed = yield* engine.snapshot(owner);
        expect(resumed.projection.runs.map((run) => run.status)).toEqual([
          "interrupted",
          "completed",
        ]);
      }),
    ),
  );

  it.effect("hides a thread from anyone but its owner", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        expect((yield* Effect.flip(engine.snapshot(stranger)))._tag).toBe("ThreadNotFoundError");
        expect(
          (yield* Effect.flip(engine.dispatch(stranger, send("x", "hi"), personal)))._tag,
        ).toBe("ThreadNotFoundError");
      }),
    ),
  );

  it.effect("records a new summary revision only when the sidebar row changes", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const launched = (yield* engine.pendingSummary)?.summary;
        expect(launched?.shell.status).toBe("starting");
        yield* engine.acknowledgeSummary(launched!.revision);
        expect(yield* engine.pendingSummary).toBeNull();

        yield* engine.step; // starting -> running changes the row
        const running = (yield* engine.pendingSummary)?.summary;
        expect(running?.shell.status).toBe("running");
        yield* engine.acknowledgeSummary(running!.revision);
        yield* engine.step; // a streamed chunk does not
        expect(yield* engine.pendingSummary).toBeNull();
      }),
    ),
  );

  it.effect("leaves no storage behind for an id that was never created", () =>
    withObject(freshDatabase(), (engine, store) =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(engine.snapshot(owner)))._tag).toBe("ThreadNotFoundError");
        expect((yield* Effect.flip(engine.dispatch(owner, send("x", "hi"), personal)))._tag).toBe(
          "ThreadNotFoundError",
        );
        expect(yield* engine.pendingSummary).toBeNull();
        expect(yield* store.initialized).toBe(false);
      }),
    ),
  );

  it.effect("keeps the reason a create was rejected", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        const rejected = yield* Effect.flip(
          engine.dispatch(
            owner,
            {
              type: "thread.create",
              commandId: CommandId.make("import"),
              createdBy: "user",
              creationSource: "web",
              threadId,
              projectId: ProjectId.make("scratch"),
              title: "Imported",
              modelSelection: scriptedModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              importedNativeThread: {
                ref: {
                  driver: ProviderDriverKind.make("codex"),
                  nativeId: "native-1",
                  strength: "strong",
                },
              },
            },
            personal,
          ),
        );
        expect(rejected._tag).toBe("ThreadCommandRejectedError");
      }),
    ),
  );
});

describe("queue edit/reorder persistence", () => {
  it.effect(
    "commits once, survives eviction, replays to clients and starts the edited queue head",
    () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        const commands = yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            yield* launch(engine);
            yield* engine.dispatch(owner, send("second", "Second"), personal);
            yield* engine.dispatch(owner, send("third", "Third"), personal);
            const before = yield* engine.snapshot(owner);
            const second = before.projection.runs[1]!;
            const third = before.projection.runs[2]!;
            const edit = {
              type: "queued-run.edit" as const,
              commandId: CommandId.make("edit-second"),
              threadId,
              runId: second.id,
              text: "Edited second",
            };
            const reorder = {
              type: "queued-run.reorder" as const,
              commandId: CommandId.make("third-first"),
              threadId,
              runId: third.id,
              beforeRunId: second.id,
            };
            const edited = yield* engine.dispatch(owner, edit, personal);
            const reordered = yield* engine.dispatch(owner, reorder, personal);
            expect(yield* engine.dispatch(owner, edit, personal)).toEqual(edited);
            expect(yield* engine.dispatch(owner, reorder, personal)).toEqual(reordered);
            const after = yield* engine.snapshot(owner);
            const replay = yield* replayFrom(engine, before.snapshotSequence);
            const events = replay.flatMap((item) => (item.kind === "event" ? [item.event] : []));
            expect(events.filter((event) => event.type === "message.updated")).toHaveLength(1);
            expect(applyEvents(before.projection, events)).toEqual(after.projection);
            for (const command of [edit, reorder]) {
              const refused = yield* engine
                .dispatch(
                  stranger,
                  { ...command, commandId: CommandId.make(`stranger-${command.type}`) },
                  personal,
                )
                .pipe(Effect.flip);
              expect(refused._tag).toBe("ThreadNotFoundError");
            }
            expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(after.snapshotSequence);
            return { edit, reorder, edited, reordered };
          }),
        );
        yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            expect(yield* engine.dispatch(owner, commands.edit, personal)).toEqual(commands.edited);
            expect(yield* engine.dispatch(owner, commands.reorder, personal)).toEqual(
              commands.reordered,
            );
            yield* runToIdle(engine);
            expect(yield* assistantTexts(engine)).toEqual([
              scriptedReply("Hello cloud"),
              scriptedReply("Third"),
              scriptedReply("Edited second"),
            ]);
            const snapshot = yield* engine.snapshot(owner);
            expect(
              snapshot.projection.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual(["Hello cloud", "Edited second", "Third"]);
          }),
        );
      }),
  );

  it.effect("records stale edit/reorder refusals and keeps messages after cancel and start", () =>
    withObject(freshDatabase(), (engine) =>
      Effect.gen(function* () {
        yield* launch(engine);
        for (const action of ["cancel", "start"] as const) {
          yield* engine.dispatch(owner, send(action, action), personal);
          const before = yield* engine.snapshot(owner);
          const queued = before.projection.runs.at(-1)!;
          if (action === "cancel") {
            yield* engine.dispatch(
              owner,
              {
                type: "queued-run.cancel",
                commandId: CommandId.make("cancel-queued"),
                threadId,
                runId: queued.id,
              },
              personal,
            );
          } else {
            // Finish the live run and let the queued run start under the engine's lock.
            for (let steps = 0; steps < 200; steps++) {
              const current = yield* engine.snapshot(owner);
              if (current.projection.runs.find((run) => run.id === queued.id)?.status !== "queued")
                break;
              yield* engine.step;
            }
          }
          const changed = yield* engine.snapshot(owner);
          const edit = {
            type: "queued-run.edit" as const,
            commandId: CommandId.make(`stale-edit-${action}`),
            threadId,
            runId: queued.id,
            text: "Must not land",
          };
          const reorder = {
            type: "queued-run.reorder" as const,
            commandId: CommandId.make(`stale-reorder-${action}`),
            threadId,
            runId: queued.id,
            beforeRunId: null,
          };
          for (const command of [edit, reorder]) {
            const rejected = yield* engine.dispatch(owner, command, personal).pipe(Effect.flip);
            expect(rejected).toMatchObject({
              _tag: "ThreadCommandRejectedError",
              commandId: command.commandId,
              commandType: command.type,
            });
            expect(yield* engine.dispatch(owner, command, personal).pipe(Effect.flip)).toEqual(
              rejected,
            );
          }
          expect((yield* engine.snapshot(owner)).projection.messages).toEqual(
            changed.projection.messages,
          );
          expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(changed.snapshotSequence);
        }
      }),
    ),
  );
});
