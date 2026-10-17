import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerThreadObject } from "../testing.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import { applyEvents } from "./threadProjection.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};
const threadId = ThreadId.make("thread-lifecycle");

const withEngine = <A, E>(
  use: (
    engine: ThreadEngine.ThreadEngine["Service"],
    store: ThreadStore.ThreadStore["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(":memory:")).pipe(
      Effect.flatMap((context) =>
        use(
          Context.get(context, ThreadEngine.ThreadEngine),
          Context.get(context, ThreadStore.ThreadStore),
        ),
      ),
    ),
  );

const launch = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  engine.launch(
    owner,
    {
      commandId: CommandId.make("lifecycle-launch"),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Lifecycle",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("lifecycle-message-1"),
        text: "Start",
        attachments: [],
      },
    },
    personal,
  );

const runToIdle = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    for (let steps = 0; steps < 200; steps++) if (!(yield* engine.step)) return;
    throw new Error("the scripted turn never settled");
  });

const makeId = (() => {
  let value = 0;
  return (label: string) => CommandId.make(`lifecycle-${label}-${++value}`);
})();

const dispatch = (engine: ThreadEngine.ThreadEngine["Service"], command: OrchestrationV2Command) =>
  engine.dispatch(owner, command, personal);

const snapshot = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.snapshot(owner), (result) => result.projection);

const events = (store: ThreadStore.ThreadStore["Service"]) =>
  Effect.map(store.events(0), (stored) => stored.map((row) => row.event));

const stableThreadFields = (thread: ThreadEngine.ThreadSnapshot["projection"]["thread"]) => {
  const {
    archivedAt: _archivedAt,
    settledOverride: _settledOverride,
    settledAt: _settledAt,
    unsettledAt: _unsettledAt,
    updatedAt: _updatedAt,
    ...stable
  } = thread;
  return stable;
};

describe("cloud thread lifecycle", () => {
  it.effect("settles, reopens, and settles again after a new done-condition", () =>
    withEngine((engine, store) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-17T10:00:00Z"));
        yield* launch(engine);
        yield* runToIdle(engine);
        const before = yield* snapshot(engine);

        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("settle"),
          threadId,
        });
        const settled = yield* snapshot(engine);
        expect(settled.thread.settledOverride).toBe("settled");
        expect(settled.thread.settledAt).toEqual(DateTime.makeUnsafe("2026-10-17T10:00:00Z"));
        expect(settled.thread.archivedAt).toEqual(settled.thread.settledAt);
        expect((yield* events(store)).map((event) => event.type)).toContain("thread.settled");

        yield* TestClock.setTime(Date.parse("2026-10-17T10:01:00Z"));
        yield* dispatch(engine, {
          type: "thread.unsettle",
          commandId: makeId("unsettle"),
          threadId,
          reason: "user",
        });
        const reopened = yield* snapshot(engine);
        expect(reopened.thread.settledOverride).toBe("active");
        expect(reopened.thread.settledAt).toBeNull();
        expect(reopened.thread.archivedAt).toBeNull();
        expect(reopened.thread.unsettledAt).toEqual(DateTime.makeUnsafe("2026-10-17T10:01:00Z"));
        expect(stableThreadFields(reopened.thread)).toEqual(stableThreadFields(before.thread));

        yield* TestClock.setTime(Date.parse("2026-10-17T10:02:00Z"));
        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("settle-again"),
          threadId,
          snapshotAt: reopened.updatedAt,
        });
        const settledAgain = yield* snapshot(engine);
        expect(settledAgain.thread.settledOverride).toBe("settled");
        expect(settledAgain.thread.archivedAt).not.toBeNull();

        const log = yield* events(store);
        expect(applyEvents(null, log)).toEqual(settledAgain);
        expect(log.map((event) => event.type)).toEqual(
          expect.arrayContaining(["thread.settled", "thread.unsettled"]),
        );
      }),
    ),
  );

  it.effect("unarchive reopens a settled task and preserves its other thread data", () =>
    withEngine((engine, store) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* runToIdle(engine);
        const before = yield* snapshot(engine);
        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("unarchive-settle"),
          threadId,
        });

        yield* dispatch(engine, {
          type: "thread.unarchive",
          commandId: makeId("unarchive-settled"),
          threadId,
        });
        const reopened = yield* snapshot(engine);
        expect(reopened.thread.archivedAt).toBeNull();
        expect(reopened.thread.settledOverride).toBe("active");
        expect(reopened.thread.settledAt).toBeNull();
        expect(stableThreadFields(reopened.thread)).toEqual(stableThreadFields(before.thread));
        const log = yield* events(store);
        expect(log.map((event) => event.type)).toEqual(
          expect.arrayContaining(["thread.settled", "thread.unsettled"]),
        );
        expect(applyEvents(null, log)).toEqual(reopened);
      }),
    ),
  );

  it.effect("guards automatic settlement against changed, overridden, and busy threads", () =>
    withEngine((engine, store) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-17T11:00:00Z"));
        yield* launch(engine);
        yield* runToIdle(engine);
        const idle = yield* snapshot(engine);

        yield* TestClock.setTime(Date.parse("2026-10-17T11:01:00Z"));
        yield* dispatch(engine, {
          type: "thread.metadata.update",
          commandId: makeId("rename"),
          threadId,
          title: "Changed",
        });
        const stale = yield* dispatch(engine, {
          type: "thread.auto-settle",
          commandId: makeId("stale-auto-settle"),
          threadId,
          snapshotAt: idle.updatedAt,
        }).pipe(Effect.flip);
        if (stale._tag !== "ThreadCommandRejectedError") throw stale;
        expect(stale.reason).toBe("This thread changed before its done-condition held.");

        const eventsBeforeStaleComplete = (yield* events(store)).length;
        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("stale-condition-settle"),
          threadId,
          snapshotAt: idle.updatedAt,
        });
        expect(yield* events(store)).toHaveLength(eventsBeforeStaleComplete);

        const current = yield* snapshot(engine);
        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("settle"),
          threadId,
        });
        const overridden = yield* dispatch(engine, {
          type: "thread.auto-settle",
          commandId: makeId("overridden-auto-settle"),
          threadId,
          snapshotAt: current.updatedAt,
        }).pipe(Effect.flip);
        if (overridden._tag !== "ThreadCommandRejectedError") throw overridden;
        expect(overridden.reason).toBe("This thread has an explicit settlement override.");

        yield* dispatch(engine, {
          type: "message.dispatch",
          commandId: makeId("message"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("lifecycle-busy-message"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const busy = yield* snapshot(engine);
        expect(busy.thread.archivedAt).toBeNull();
        const eventsBeforeBusySettle = (yield* events(store)).length;
        const activeSettle = yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("busy-active-settle"),
          threadId,
        }).pipe(Effect.flip);
        if (activeSettle._tag !== "ThreadCommandRejectedError") throw activeSettle;
        expect(activeSettle.reason).toBe(
          "This thread is still working. Stop it or let it finish, then settle it.",
        );
        expect(yield* events(store)).toHaveLength(eventsBeforeBusySettle);

        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("busy-settle"),
          threadId,
          snapshotAt: busy.updatedAt,
        });
        expect(yield* events(store)).toHaveLength(eventsBeforeBusySettle);
      }),
    ),
  );

  it.effect("stops active work, holds its queued message, and settles in one command", () =>
    withEngine((engine, store) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-17T11:30:00Z"));
        yield* launch(engine);
        const starting = yield* snapshot(engine);
        const active = starting.runs.find((run) => run.status === "starting");
        expect(active).toBeDefined();

        const queuedMessageId = MessageId.make("lifecycle-early-queued-message");
        yield* dispatch(engine, {
          type: "message.dispatch",
          commandId: makeId("early-queued-message"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: queuedMessageId,
          text: "Keep this queued message",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const before = yield* snapshot(engine);
        const queued = before.runs.find((run) => run.status === "queued");
        expect(queued).toBeDefined();
        const priorEventCount = (yield* events(store)).length;

        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("early-settle"),
          threadId,
          stopWork: true,
        });

        const settled = yield* snapshot(engine);
        expect(settled.thread.archivedAt).not.toBeNull();
        expect(settled.thread.settledOverride).toBe("settled");
        expect(settled.runs.find((run) => run.id === active?.id)?.status).toBe("interrupted");
        expect(settled.runs.find((run) => run.id === queued?.id)).toMatchObject({
          status: "queued",
          queueHeld: true,
        });
        expect(settled.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: queuedMessageId,
              text: "Keep this queued message",
              role: "user",
            }),
          ]),
        );

        const commandEvents = (yield* events(store)).slice(priorEventCount);
        const interruptedIndex = commandEvents.findIndex(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === active?.id &&
            event.payload.status === "interrupted",
        );
        const heldIndex = commandEvents.findIndex(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queued?.id &&
            event.payload.queueHeld === true,
        );
        const settledIndex = commandEvents.findIndex((event) => event.type === "thread.settled");
        expect(interruptedIndex).toBeGreaterThanOrEqual(0);
        expect(heldIndex).toBeGreaterThanOrEqual(0);
        expect(settledIndex).toBeGreaterThan(interruptedIndex);
        expect(settledIndex).toBeGreaterThan(heldIndex);
        expect(commandEvents.at(-1)?.type).toBe("thread.settled");
        expect(applyEvents(before, commandEvents)).toEqual(settled);
      }),
    ),
  );

  it.effect("holds a queued message when early settling with no active run", () =>
    withEngine((engine, store) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const starting = yield* snapshot(engine);
        const active = starting.runs.find((run) => run.status === "starting");
        expect(active).toBeDefined();

        const queuedMessageId = MessageId.make("lifecycle-idle-queued-message");
        yield* dispatch(engine, {
          type: "message.dispatch",
          commandId: makeId("idle-queued-message"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: queuedMessageId,
          text: "Leave this message queued",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const queuedBeforeStop = (yield* snapshot(engine)).runs.find(
          (run) => run.status === "queued",
        );
        expect(queuedBeforeStop).toBeDefined();

        yield* dispatch(engine, {
          type: "run.interrupt",
          commandId: makeId("interrupt-with-held-queue"),
          threadId,
          runId: active!.id,
          holdQueue: true,
        });
        const idleWithQueue = yield* snapshot(engine);
        expect(idleWithQueue.runs.some((run) => run.status === "starting")).toBe(false);
        const priorEventCount = (yield* events(store)).length;

        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("early-settle-idle-queue"),
          threadId,
          stopWork: true,
        });

        const settled = yield* snapshot(engine);
        const commandEvents = (yield* events(store)).slice(priorEventCount);
        expect(commandEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "run.updated",
              payload: expect.objectContaining({ id: queuedBeforeStop!.id, queueHeld: true }),
            }),
          ]),
        );
        expect(settled.runs.find((run) => run.id === queuedBeforeStop!.id)).toMatchObject({
          status: "queued",
          queueHeld: true,
        });
        expect(settled.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: queuedMessageId, text: "Leave this message queued" }),
          ]),
        );
        expect(commandEvents.at(-1)?.type).toBe("thread.settled");
      }),
    ),
  );

  it.effect("a new message reopens settled work and archive-only chats", () =>
    withEngine((engine, store) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* runToIdle(engine);
        yield* dispatch(engine, {
          type: "thread.settle",
          commandId: makeId("settle"),
          threadId,
        });
        const settled = yield* snapshot(engine);
        yield* dispatch(engine, {
          type: "message.dispatch",
          commandId: makeId("reopen-message"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("lifecycle-reopen-message"),
          text: "One more thing",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const reopened = yield* snapshot(engine);
        expect(reopened.thread.archivedAt).toBeNull();
        expect(reopened.thread.settledOverride).toBeNull();
        expect(reopened.thread.settledAt).toBeNull();
        expect(reopened.messages).toHaveLength(settled.messages.length + 1);
        const log = yield* events(store);
        const lifecycle = log
          .filter((event) => event.type === "thread.settled" || event.type === "thread.unsettled")
          .map((event) => event.type);
        expect(lifecycle).toEqual(["thread.settled", "thread.unsettled"]);

        yield* runToIdle(engine);
        yield* dispatch(engine, {
          type: "thread.archive",
          commandId: makeId("archive-chat"),
          threadId,
        });
        yield* dispatch(engine, {
          type: "message.dispatch",
          commandId: makeId("reopen-chat-message"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("lifecycle-reopen-chat-message"),
          text: "A chat can continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const reopenedChat = yield* snapshot(engine);
        expect(reopenedChat.thread.archivedAt).toBeNull();
        expect(reopenedChat.thread.settledOverride).toBeNull();
        expect((yield* events(store)).map((event) => event.type)).toContain("thread.unarchived");
      }),
    ),
  );
});
