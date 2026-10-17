// @effect-diagnostics nodeBuiltinImport:off - the eviction tests need a database file that outlives one object.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AutomationError,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as CloudAutomations from "../automations/CloudAutomations.ts";
import * as Environment from "../environment.ts";
import { layerThreadObject, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "./CloudThreadService.ts";
import { deliverPendingEvents } from "./eventOutbox.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import * as UserDirectory from "../user/UserDirectory.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};
const threadId = ThreadId.make("thread-1");
const monitor = { taskId: "automation-run:auto-1:run-1", description: "Waiting for CI" };

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

/** A fresh database file; each `withObject` on it is the object waking up again. */
const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-events-"));
  directories.push(directory);
  return NodePath.join(directory, "thread.sqlite");
};

interface Delivery {
  readonly threadId: string;
  readonly events: ReadonlyArray<{
    readonly sequence: number;
    readonly event: OrchestrationV2DomainEvent;
  }>;
}

/**
 * The owner's object with automations that record what they take, reached
 * through the same RPC encoding as production. `down` makes them fail.
 */
const makeOwner = () => {
  const received: Array<Delivery> = [];
  const state = { down: false };
  const automations = CloudAutomations.CloudAutomations.of({
    save: () => Effect.die("not in these tests"),
    threadEvents: (input) =>
      state.down
        ? Effect.fail(new AutomationError({ message: "The engine is down." }))
        : Effect.sync(() => {
            received.push(input);
          }),
    driveEvents: () => Effect.void,
    tool: () => Effect.die("not in these tests"),
    wake: Effect.void,
    flush: Effect.void,
    start: Effect.void,
    host: () => Effect.die("not in these tests"),
    workerModule: () => Effect.die("not in these tests"),
  });
  const cloud = makeMemoryCloud({
    automations: Layer.succeed(CloudAutomations.CloudAutomations, automations),
  });
  return { received, state, users: cloud.userDirectory };
};

const withObject = <A, E>(
  filename: string,
  users: UserDirectory.UserDirectory["Service"],
  use: (object: {
    readonly engine: ThreadEngine.ThreadEngine["Service"];
    readonly store: ThreadStore.ThreadStore["Service"];
    readonly sql: SqlClient.SqlClient;
    /** What the object's alarm does for its event outbox. */
    readonly deliver: Effect.Effect<boolean>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(
      Layer.merge(layerThreadObject(filename), Layer.succeed(UserDirectory.UserDirectory, users)),
    ).pipe(
      Effect.flatMap((context) =>
        use({
          engine: Context.get(context, ThreadEngine.ThreadEngine),
          store: Context.get(context, ThreadStore.ThreadStore),
          sql: Context.get(context, SqlClient.SqlClient),
          deliver: Effect.provideContext(deliverPendingEvents, context),
        }),
      ),
    ),
  );

const launch = (engine: ThreadEngine.ThreadEngine["Service"]) =>
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
      initialMessage: { messageId: MessageId.make("message-1"), text: "Hello", attachments: [] },
    },
    personal,
  );

const send = (engine: ThreadEngine.ThreadEngine["Service"], id: string) =>
  engine.dispatch(
    owner,
    {
      type: "message.dispatch",
      commandId: CommandId.make(id),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(`message-${id}`),
      text: "Again",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    },
    personal,
  );

const runToIdle = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    for (let steps = 0; steps < 200; steps++) {
      if (!(yield* engine.step)) return;
    }
    throw new Error("the scripted turn never settled");
  });

/** The event ids the store holds after `after`, oldest first. */
const storedIds = (store: ThreadStore.ThreadStore["Service"], after = 0) =>
  Effect.map(Effect.orDie(store.events(after)), (stored) => stored.map(({ event }) => event.id));

const receivedIds = (received: ReadonlyArray<Delivery>) =>
  received.flatMap((delivery) => delivery.events.map(({ event }) => event.id));

const receivedSequences = (received: ReadonlyArray<Delivery>) =>
  received.flatMap((delivery) => delivery.events.map(({ sequence }) => sequence));

/** `count` sequences from `from`. */
const sequencesFrom = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => from + index);

describe("thread event outbox", () => {
  it.effect("delivers committed events in order, and nothing again once acknowledged", () => {
    const user = makeOwner();
    return withObject(freshDatabase(), user.users, ({ engine, store, deliver }) =>
      Effect.gen(function* () {
        yield* launch(engine);
        yield* runToIdle(engine);
        expect(yield* engine.hasPendingEvents).toBe(true);
        expect(yield* deliver).toBe(true);
        expect(receivedIds(user.received)).toEqual(yield* storedIds(store));
        const head = (yield* Effect.orDie(store.events(0))).length;
        expect(receivedSequences(user.received)).toEqual(sequencesFrom(1, head));
        expect(user.received.every((delivery) => delivery.threadId === threadId)).toBe(true);

        // Acknowledged: nothing is pending, and delivering again sends nothing.
        expect(yield* engine.hasPendingEvents).toBe(false);
        const calls = user.received.length;
        expect(yield* deliver).toBe(true);
        expect(user.received).toHaveLength(calls);

        // The next turn's events follow on from there.
        yield* send(engine, "again");
        yield* runToIdle(engine);
        yield* deliver;
        expect(receivedIds(user.received.slice(calls))).toEqual(yield* storedIds(store, head));
        expect(receivedSequences(user.received.slice(calls))[0]).toBe(head + 1);
      }),
    );
  });

  it.effect("sends the same events again after a failed call", () => {
    const user = makeOwner();
    return withObject(freshDatabase(), user.users, ({ engine, store, deliver }) =>
      Effect.gen(function* () {
        yield* launch(engine);
        user.state.down = true;
        expect(yield* deliver).toBe(false);
        expect(yield* engine.hasPendingEvents).toBe(true);
        expect(user.received).toEqual([]);

        user.state.down = false;
        expect(yield* deliver).toBe(true);
        expect(receivedIds(user.received)).toEqual(yield* storedIds(store));
      }),
    );
  });

  it.effect("keeps its cursor across eviction", () => {
    const user = makeOwner();
    const filename = freshDatabase();
    return Effect.gen(function* () {
      const head = yield* withObject(filename, user.users, ({ engine, store, deliver }) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* runToIdle(engine);
          yield* deliver;
          return (yield* Effect.orDie(store.events(0))).length;
        }),
      );
      const calls = user.received.length;
      yield* withObject(filename, user.users, ({ engine, store, deliver }) =>
        Effect.gen(function* () {
          expect(yield* engine.hasPendingEvents).toBe(false);
          yield* deliver;
          expect(user.received).toHaveLength(calls);
          yield* send(engine, "after-wake");
          yield* deliver;
          expect(receivedIds(user.received.slice(calls))).toEqual(yield* storedIds(store, head));
        }),
      );
    });
  });

  it.effect("starts a thread from before automations at its head", () => {
    const user = makeOwner();
    const filename = freshDatabase();
    return Effect.gen(function* () {
      const head = yield* withObject(filename, user.users, ({ engine, store, sql }) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* runToIdle(engine);
          // As a thread created before the migration was.
          yield* Effect.orDie(sql`DROP TABLE event_outbox`);
          yield* Effect.orDie(sql`DROP TABLE thread_monitors`);
          yield* Effect.orDie(sql`DELETE FROM effect_sql_migrations WHERE name = 'automations'`);
          return (yield* Effect.orDie(store.events(0))).length;
        }),
      );
      yield* withObject(filename, user.users, ({ engine, store, deliver }) =>
        Effect.gen(function* () {
          expect(yield* engine.hasPendingEvents).toBe(false);
          yield* send(engine, "after-upgrade");
          yield* deliver;
          expect(receivedIds(user.received)).toEqual(yield* storedIds(store, head));
        }),
      );
    });
  });
});

const tasksOf = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.summary(owner), (summary) => summary?.shell.pendingBackgroundTasks);

describe("attached-run monitors", () => {
  it.effect("list as monitors once the turn ends, with a new summary revision each change", () => {
    const user = makeOwner();
    const filename = freshDatabase();
    return Effect.gen(function* () {
      yield* withObject(filename, user.users, ({ engine }) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* engine.setMonitors(owner, [monitor]);
          // A running turn hides background work, as upstream's does.
          expect(yield* tasksOf(engine)).toEqual([]);
          yield* runToIdle(engine);
          expect(yield* tasksOf(engine)).toEqual([{ ...monitor, kind: "monitor" }]);
          const shown = yield* engine.pendingSummary;
          expect(shown?.summary.shell.pendingBackgroundTasks).toHaveLength(1);
          yield* engine.acknowledgeSummary(shown?.summary.revision ?? 0);

          // The same list again changes nothing.
          yield* engine.setMonitors(owner, [monitor]);
          expect(yield* engine.pendingSummary).toBeNull();
        }),
      );
      // They outlive eviction; an empty list clears them under a newer revision.
      yield* withObject(filename, user.users, ({ engine, store }) =>
        Effect.gen(function* () {
          expect(yield* tasksOf(engine)).toEqual([{ ...monitor, kind: "monitor" }]);
          const before = (yield* Effect.orDie(store.outbox)).revision;
          yield* engine.setMonitors(owner, []);
          const cleared = yield* engine.pendingSummary;
          expect(cleared?.summary.revision).toBeGreaterThan(before);
          expect(cleared?.summary.shell.pendingBackgroundTasks).toEqual([]);
          // A later event still lands on a newer revision than the monitors'.
          yield* send(engine, "after-clear");
          expect((yield* engine.pendingSummary)?.summary.revision).toBeGreaterThan(
            cleared?.summary.revision ?? 0,
          );
        }),
      );
    });
  });

  it.effect("refuses a thread that was never created, and anyone but its owner", () => {
    const user = makeOwner();
    return withObject(freshDatabase(), user.users, ({ engine }) =>
      Effect.gen(function* () {
        const unknown = yield* Effect.flip(engine.setMonitors(owner, [monitor]));
        expect(unknown._tag).toBe("ThreadNotFoundError");
        yield* launch(engine);
        yield* runToIdle(engine);
        const stranger = { userId: "user_2", contextIds: [PERSONAL_CONTEXT_ID] };
        const refused = yield* Effect.flip(engine.setMonitors(stranger, [monitor]));
        expect(refused._tag).toBe("ThreadNotFoundError");
        expect(yield* tasksOf(engine)).toEqual([]);
      }),
    );
  });

  it.effect("reach the owner's sidebar, and leave it when cleared", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(cloud.layerPersonal(owner.userId)),
      );
      const { threadId: launched } = yield* service.launchThread(owner, {
        commandId: CommandId.make("launch-sidebar"),
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Hello",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: "Hello", attachments: [] },
      });
      yield* cloud.settle;
      const sidebarTasks = Effect.map(
        cloud.userDirectory.forUser(owner.userId).shellSnapshot(),
        (snapshot) =>
          snapshot.threads.find((thread) => thread.id === launched)?.pendingBackgroundTasks,
      );
      expect(yield* sidebarTasks).toEqual([]);

      const thread = cloud.threadDirectory.forThread(launched);
      yield* thread.setMonitors(owner, [monitor]);
      yield* cloud.settle;
      expect(yield* sidebarTasks).toEqual([{ ...monitor, kind: "monitor" }]);

      yield* thread.setMonitors(owner, []);
      yield* cloud.settle;
      expect(yield* sidebarTasks).toEqual([]);

      // Someone else's call changes nothing, and doesn't fail.
      yield* thread.setMonitors({ userId: "user_2", contextIds: [PERSONAL_CONTEXT_ID] }, [monitor]);
      yield* cloud.settle;
      expect(yield* sidebarTasks).toEqual([]);
    }),
  );
});
