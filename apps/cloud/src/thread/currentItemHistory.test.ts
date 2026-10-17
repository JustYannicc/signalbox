// @effect-diagnostics nodeBuiltinImport:off - these tests need SQLite files to outlive an object.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AutomationError,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as CloudAutomations from "../automations/CloudAutomations.ts";
import { layerThreadObject, makeMemoryCloud } from "../testing.ts";
import { deliverPendingEvents } from "./eventOutbox.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { turnItemEvent } from "./threadEvents.ts";
import { applyEvents } from "./threadProjection.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import * as ThreadStore from "./ThreadStore.ts";
import * as UserDirectory from "../user/UserDirectory.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};
const threadId = ThreadId.make("thread-current-items");
const toolId = TurnItemId.make("tool-current-item");
const secondToolId = TurnItemId.make("tool-second-item");
const todoId = TurnItemId.make("todo-current-item");

const directories: Array<string> = [];
const EventJson = Schema.fromJsonString(OrchestrationV2DomainEventJson);
const encodeEvent = Schema.encodeSync(EventJson);
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-current-items-"));
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

const makeOwner = () => {
  const received: Array<Delivery> = [];
  const state = { down: false };
  const automations = CloudAutomations.CloudAutomations.of({
    receiveHook: () => Effect.die("not used"),
    threadEvents: (input) =>
      state.down
        ? Effect.fail(new AutomationError({ message: "The engine is down." }))
        : Effect.sync(() => {
            received.push(input);
          }),
    driveEvents: () => Effect.void,
    tool: () => Effect.die("not used"),
    wake: Effect.void,
    flush: Effect.void,
    start: Effect.void,
    host: () => Effect.die("not used"),
    workerModule: () => Effect.die("not used"),
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
      commandId: CommandId.make("launch-current-items"),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Current item history",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("initial-current-items"),
        text: "Keep state",
        attachments: [],
      },
    },
    personal,
  );

const runIdOf = (projection: OrchestrationV2ThreadProjection) => {
  const runId = projection.runs[0]?.id;
  if (runId === undefined) throw new Error("The fixture thread has no run.");
  return runId;
};

const commandItem = (
  now: Parameters<typeof turnItemEvent>[0]["now"],
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
  id: TurnItemId,
  ordinal: number,
  status: "running" | "completed",
  output: string,
): OrchestrationV2DomainEvent =>
  turnItemEvent(
    { now },
    {
      id,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status,
      title: "Run command",
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
      type: "command_execution",
      input: "printf fixture",
      output,
      ...(status === "completed" ? { exitCode: 0 } : {}),
    },
  );

const todoItem = (
  now: Parameters<typeof turnItemEvent>[0]["now"],
  runId: NonNullable<OrchestrationV2TurnItem["runId"]>,
  status: "pending" | "running" | "completed",
): OrchestrationV2DomainEvent =>
  turnItemEvent(
    { now },
    {
      id: todoId,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: "Plan steps",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "todo_list",
      planId: PlanId.make("plan-current-items"),
      steps: [{ id: "step-1", text: "Keep each state change", status }],
    },
  );

const applyItem = (
  engine: ThreadEngine.ThreadEngine["Service"],
  makeEvent: (now: Parameters<typeof turnItemEvent>[0]["now"]) => OrchestrationV2DomainEvent,
) => engine.apply((_, ctx) => Effect.succeed({ events: [makeEvent(ctx.now)], result: undefined }));

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

const eventsOf = (
  items: ReadonlyArray<{ readonly kind: string; readonly event?: OrchestrationV2DomainEvent }>,
) => items.flatMap((item) => (item.kind === "event" && item.event ? [item.event] : []));

const commandOutput = (event: OrchestrationV2DomainEvent | undefined) =>
  event?.type === "turn-item.updated" && event.payload.type === "command_execution"
    ? event.payload.output
    : null;

describe("current cloud item history", () => {
  it.effect(
    "stores one full current row per item and rebuilds interleaved items in first-seen order",
    () => {
      const filename = freshDatabase();
      const user = makeOwner();
      return Effect.gen(function* () {
        const first = yield* withObject(filename, user.users, ({ engine, store, sql }) =>
          Effect.gen(function* () {
            const created = yield* launch(engine);
            const start = yield* engine.snapshot(owner);
            const headBefore = start.snapshotSequence;
            const retried = yield* launch(engine);
            expect(retried.resumed).toBe(true);
            expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(headBefore);

            const runId = runIdOf(created.projection);
            const collectLive = yield* engine
              .subscribe(owner, { threadId, afterSequence: headBefore })
              .pipe(
                Effect.flatMap((stream) =>
                  stream.pipe(
                    Stream.flattenIterable,
                    Stream.take(101),
                    Stream.runCollect,
                    Effect.forkChild,
                  ),
                ),
              );

            for (let index = 1; index <= 100; index++) {
              const output = `chunk-${index}:` + "x".repeat(index * 32);
              yield* applyItem(engine, (now) =>
                commandItem(
                  now,
                  runId,
                  toolId,
                  100,
                  index === 100 ? "completed" : "running",
                  output,
                ),
              );
              if (index === 1) {
                yield* applyItem(engine, (now) =>
                  commandItem(now, runId, secondToolId, 200, "completed", "second item"),
                );
              }
            }

            const live = yield* Fiber.join(collectLive);
            expect(live).toHaveLength(101);
            expect(live.map((entry) => (entry.kind === "event" ? entry.sequence : null))).toEqual(
              Array.from({ length: 101 }, (_, index) => headBefore + index + 1),
            );

            const finalOutput = `chunk-100:` + "x".repeat(100 * 32);
            const toolRows = yield* sql<{ readonly count: number; readonly bytes: number }>`
            SELECT COUNT(*) AS count, COALESCE(SUM(length(event)), 0) AS bytes
            FROM events
            WHERE json_extract(event, '$.type') = 'turn-item.updated'
              AND json_extract(event, '$.payload.id') = ${toolId}
          `;
            const [toolStorage] = toolRows;
            expect(toolStorage?.count).toBe(1);
            expect(toolStorage?.bytes).toBeLessThan(finalOutput.length * 2);

            const secondRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM events
            WHERE json_extract(event, '$.type') = 'turn-item.updated'
              AND json_extract(event, '$.payload.id') = ${secondToolId}
          `;
            expect(secondRows[0]?.count).toBe(1);

            const current = yield* store.events(0);
            const saved = current.find(
              (row) => row.event.type === "turn-item.updated" && row.event.payload.id === toolId,
            );
            expect(saved?.event.type).toBe("turn-item.updated");
            expect(commandOutput(saved?.event)).toBe(finalOutput);

            const head = yield* store.head;
            expect(head).toBe(headBefore + 101);
            const rebuilt = applyEvents(
              null,
              current.map((row) => row.event),
            );
            expect(rebuilt?.turnItems.map((item) => item.id)).toContain(toolId);
            expect(rebuilt?.turnItems.map((item) => item.id)).toContain(secondToolId);
            const rebuiltTool = rebuilt?.turnItems.find((item) => item.id === toolId);
            expect(rebuiltTool?.type === "command_execution" ? rebuiltTool.output : null).toBe(
              finalOutput,
            );
            expect(rebuilt?.turnItems.map((item) => item.ordinal)).toEqual(
              rebuilt?.turnItems
                .map((item) => item.ordinal)
                .toSorted((left, right) => left - right),
            );

            const beforeUpdates = yield* replayFrom(engine, headBefore);
            const betweenUpdates = yield* replayFrom(engine, headBefore + 50);
            const afterUpdates = yield* replayFrom(engine, head);
            expect(
              eventsOf(beforeUpdates).filter((event) => event.type === "turn-item.updated"),
            ).toHaveLength(2);
            const betweenItems = eventsOf(betweenUpdates).filter(
              (event) => event.type === "turn-item.updated",
            );
            expect(betweenItems).toHaveLength(1);
            expect(commandOutput(betweenItems[0])).toBe(finalOutput);
            expect(eventsOf(afterUpdates)).toEqual([]);
            expect(afterUpdates.at(-1)?.kind).toBe("synchronized");

            expect((yield* engine.snapshot(owner)).projection).toEqual(rebuilt);
            return { head, projection: rebuilt };
          }),
        );

        const afterRestart = yield* withObject(filename, user.users, ({ engine, store }) =>
          Effect.gen(function* () {
            const snapshot = yield* engine.snapshot(owner);
            const storedHead = yield* store.head;
            const current = yield* store.events(0);
            return {
              snapshot,
              storedHead,
              rebuilt: applyEvents(
                null,
                current.map((row) => row.event),
              ),
            };
          }),
        );
        expect(afterRestart.storedHead).toBe(first.head);
        expect(afterRestart.snapshot.snapshotSequence).toBe(first.head);
        expect(afterRestart.snapshot.projection).toEqual(first.projection);
        expect(afterRestart.rebuilt).toEqual(first.projection);
      });
    },
  );

  it.effect(
    "keeps one start and each distinct todo transition through failed delivery, ack, and later updates",
    () => {
      const filename = freshDatabase();
      const user = makeOwner();
      return withObject(filename, user.users, ({ engine, store, deliver }) =>
        Effect.gen(function* () {
          const created = yield* launch(engine);
          yield* engine.acknowledgeEvents(yield* store.head);
          const runId = runIdOf(created.projection);

          yield* applyItem(engine, (now) =>
            commandItem(now, runId, toolId, 100, "running", "partial output"),
          );
          yield* applyItem(engine, (now) =>
            commandItem(now, runId, toolId, 100, "completed", "complete output"),
          );
          user.state.down = true;
          expect(yield* deliver).toBe(false);
          expect(user.received).toEqual([]);

          yield* applyItem(engine, (now) =>
            commandItem(now, runId, toolId, 100, "completed", "complete output after retry"),
          );
          user.state.down = false;
          expect(yield* deliver).toBe(true);
          const deliveredToolEvents = user.received
            .flatMap((batch) => batch.events)
            .filter(
              ({ event }) => event.type === "turn-item.updated" && event.payload.id === toolId,
            );
          expect(
            deliveredToolEvents.map(({ event }) =>
              event.type === "turn-item.updated" ? event.payload.status : null,
            ),
          ).toEqual(["running", "completed"]);
          expect(commandOutput(deliveredToolEvents.at(-1)?.event)).toBe(
            "complete output after retry",
          );
          expect(yield* engine.hasPendingEvents).toBe(false);

          const afterAck = yield* store.head;
          yield* applyItem(engine, (now) =>
            commandItem(now, runId, toolId, 100, "completed", "output after ack"),
          );
          const later = yield* engine.pendingEvents(50);
          expect(later?.events.map((event) => event.sequence)).toEqual([afterAck + 1]);
          expect(commandOutput(later?.events[0]?.event)).toBe("output after ack");
          // Another update commits while the previous delivery is in flight.
          yield* applyItem(engine, (now) =>
            commandItem(now, runId, toolId, 100, "completed", "output during delivery"),
          );
          yield* engine.acknowledgeEvents(afterAck + 1);
          const stillPending = yield* engine.pendingEvents(50);
          expect(stillPending?.events.map((event) => event.sequence)).toEqual([afterAck + 2]);
          expect(commandOutput(stillPending?.events[0]?.event)).toBe("output during delivery");
          expect(yield* deliver).toBe(true);
          expect(user.received.flatMap((batch) => batch.events).at(-1)?.sequence).toBe(
            afterAck + 2,
          );

          yield* applyItem(engine, (now) => todoItem(now, runId, "pending"));
          yield* applyItem(engine, (now) => todoItem(now, runId, "running"));
          yield* applyItem(engine, (now) => todoItem(now, runId, "completed"));
          const pendingTodos = yield* engine.pendingEvents(50);
          const todoTransitions = pendingTodos?.events.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.id === todoId &&
            event.payload.type === "todo_list"
              ? [event.payload.steps[0]?.status]
              : [],
          );
          expect(todoTransitions).toEqual(["pending", "running", "completed"]);

          const todoHead = pendingTodos?.events.at(-1)?.sequence;
          if (todoHead === undefined) throw new Error("Todo transitions were not queued.");
          yield* engine.acknowledgeEvents(todoHead);
          expect(yield* engine.pendingEvents(50)).toBeNull();

          // The delivery cursor is a high-water mark, independent of the smaller canonical history.
          expect(yield* store.eventsForDelivery(todoHead)).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "normalizes a legacy multi-row item history without losing its final output or pending start",
    () =>
      withObject(freshDatabase(), makeOwner().users, ({ engine, store, sql }) =>
        Effect.gen(function* () {
          const created = yield* launch(engine);
          const runId = runIdOf(created.projection);
          const head = yield* store.head;
          yield* engine.acknowledgeEvents(head);

          const triggers = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'events'
        `;
          for (const trigger of triggers) yield* sql`DROP TRIGGER ${sql(trigger.name)}`;
          const indexes = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'
        `;
          for (const index of indexes) {
            const columns = yield* sql<{
              readonly name: string;
            }>`PRAGMA index_info(${sql(index.name)})`;
            if (columns.some((column) => column.name.includes("item")))
              yield* sql`DROP INDEX ${sql(index.name)}`;
          }

          const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(events)`;
          if (columns.some((column) => column.name === "turn_item_id"))
            yield* sql`ALTER TABLE events DROP COLUMN turn_item_id`;

          const now = yield* DateTime.now;
          const itemEvents = [
            commandItem(now, runId, toolId, 100, "running", "partial"),
            commandItem(now, runId, toolId, 100, "running", "more partial"),
            commandItem(now, runId, toolId, 100, "completed", "legacy final output"),
          ];
          let sequence = head;
          for (const event of itemEvents) {
            sequence += 1;
            const encoded = encodeEvent(event);
            yield* sql`INSERT INTO events (sequence, command_id, format, event)
            VALUES (${sequence}, ${null}, ${1}, ${encoded})`;
          }

          // Re-run only the newly appended, immutable migration as an old deployment would.
          const migrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id = 12 AND name = 'current_item_history'
        `;
          for (const migration of migrations) {
            yield* sql`DELETE FROM effect_sql_migrations
            WHERE migration_id = ${migration.migration_id} AND name = ${migration.name}`;
          }
          yield* sql`DROP TRIGGER IF EXISTS events_high_water`;
          for (const table of [
            "current_turn_items",
            "item_event_outbox",
            "event_sequence",
            "item_history_normalization",
          ]) {
            yield* sql`DROP TABLE ${sql(table)}`;
          }
          yield* store.initialize;

          const rows = yield* store.events(head);
          const itemRows = rows.filter(
            (row) => row.event.type === "turn-item.updated" && row.event.payload.id === toolId,
          );
          expect(itemRows).toHaveLength(1);
          expect(commandOutput(itemRows[0]?.event)).toBe("legacy final output");
          const pending = yield* store.eventsForDelivery(head);
          const pendingToolEvents = pending.filter(
            (row) => row.event.type === "turn-item.updated" && row.event.payload.id === toolId,
          );
          expect(
            pendingToolEvents.map((row) =>
              row.event.type === "turn-item.updated" ? row.event.payload.status : null,
            ),
          ).toEqual(["running", "completed"]);
          expect(yield* store.head).toBe(head + 3);
        }),
      ),
  );
});
