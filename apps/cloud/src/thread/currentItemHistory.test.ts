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
import * as Deferred from "effect/Deferred";
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
const decodeEvent = Schema.decodeUnknownSync(EventJson);
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
    save: () => Effect.die("not used"),
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
            expect(toolStorage?.count).toBe(100);
            expect(toolStorage?.bytes).toBeGreaterThan(finalOutput.length);

            const secondRows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM events
            WHERE json_extract(event, '$.type') = 'turn-item.updated'
              AND json_extract(event, '$.payload.id') = ${secondToolId}
          `;
            expect(secondRows[0]?.count).toBe(1);

            const canonical = yield* sql<{
              readonly sequence: number;
              readonly first_sequence: number;
              readonly ordinal: number;
              readonly event: string;
            }>`
              SELECT sequence, first_sequence, ordinal, event FROM signalbox_turn_item_state
              WHERE item_id = ${toolId}
            `;
            expect(canonical).toHaveLength(1);
            expect(canonical[0]?.sequence).toBe(headBefore + 101);
            expect(canonical[0]?.first_sequence).toBe(headBefore + 1);
            expect(canonical[0]?.ordinal).toBe(100);
            expect(commandOutput(decodeEvent(canonical[0]?.event))).toBe(finalOutput);
            expect(
              yield* sql`SELECT item_id FROM signalbox_turn_item_state
                WHERE item_id IN (${toolId}, ${secondToolId}) ORDER BY first_sequence`,
            ).toEqual([{ item_id: toolId }, { item_id: secondToolId }]);

            const current = yield* store.events(0);
            const saved = current.findLast(
              (row) => row.event.type === "turn-item.updated" && row.event.payload.id === toolId,
            );
            expect(saved?.event.type).toBe("turn-item.updated");
            expect(commandOutput(saved?.event)).toBe(finalOutput);

            const head = current.at(-1)?.sequence ?? 0;
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
            expect(
              rebuilt?.turnItems
                .filter((item) => item.id === toolId || item.id === secondToolId)
                .map((item) => item.id),
            ).toEqual([toolId, secondToolId]);

            const beforeUpdates = yield* replayFrom(engine, headBefore);
            const betweenUpdates = yield* replayFrom(engine, headBefore + 50);
            const afterUpdates = yield* replayFrom(engine, head);
            expect(
              eventsOf(beforeUpdates).filter((event) => event.type === "turn-item.updated"),
            ).toHaveLength(101);
            const betweenItems = eventsOf(betweenUpdates).filter(
              (event) => event.type === "turn-item.updated",
            );
            expect(betweenItems).toHaveLength(51);
            expect(commandOutput(betweenItems.at(-1))).toBe(finalOutput);
            expect(eventsOf(afterUpdates)).toEqual([]);
            expect(afterUpdates.at(-1)?.kind).toBe("synchronized");

            expect((yield* engine.snapshot(owner)).projection).toEqual(rebuilt);
            return { head, projection: rebuilt };
          }),
        );

        const afterRestart = yield* withObject(filename, user.users, ({ engine, store }) =>
          Effect.gen(function* () {
            const snapshot = yield* engine.snapshot(owner);
            const storedHead = (yield* store.events(0)).at(-1)?.sequence ?? 0;
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
          const initialHead = (yield* store.events(0)).at(-1)?.sequence ?? 0;
          yield* engine.acknowledgeEvents(initialHead);
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
          ).toEqual(["running", "completed", "completed"]);
          expect(commandOutput(deliveredToolEvents.at(-1)?.event)).toBe(
            "complete output after retry",
          );
          expect(yield* engine.hasPendingEvents).toBe(false);

          const afterAck = (yield* store.events(0)).at(-1)?.sequence ?? 0;
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

          // The full history stays available to the original automation reader.
          expect(yield* store.events(todoHead)).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "resumes the additive backfill after a committed page without changing legacy history",
    () => {
      const filename = freshDatabase();
      const user = makeOwner();
      return Effect.gen(function* () {
        const { head, finalOutput, legacyLog } = yield* withObject(
          filename,
          user.users,
          ({ engine, store, sql }) =>
            Effect.gen(function* () {
              const created = yield* launch(engine);
              const runId = runIdOf(created.projection);
              const head = (yield* store.events(0)).at(-1)?.sequence ?? 0;
              expect(head).toBeLessThan(99);
              yield* engine.acknowledgeEvents(head);

              const now = yield* DateTime.now;
              const finalOutput = "legacy final output\n".repeat(500);
              for (let index = 0; index < 205; index++) {
                const event =
                  index === 1
                    ? commandItem(now, runId, secondToolId, 200, "completed", "second item")
                    : commandItem(
                        now,
                        runId,
                        toolId,
                        index === 0 ? 100 : 999,
                        index === 204 ? "completed" : "running",
                        index === 204 ? finalOutput : `partial:${index}`,
                      );
                yield* sql`INSERT INTO events (sequence, command_id, format, event)
                  VALUES (${head + index + 1}, NULL, 1, ${encodeEvent(event)})`;
              }
              const legacyLog = yield* sql<{
                readonly sequence: number;
                readonly format: number;
                readonly event: string;
              }>`SELECT sequence, format, event FROM events ORDER BY sequence`;

              // Model a preview that recorded the old 0012 but has not applied 0013.
              yield* sql`DROP TABLE signalbox_turn_item_state`;
              yield* sql`DROP TABLE signalbox_turn_item_backfill`;
              yield* sql`DELETE FROM effect_sql_migrations
                WHERE migration_id = 13 AND name = 'current_item_expansion'`;
              yield* sql`CREATE TABLE current_turn_items (
                item_id TEXT PRIMARY KEY, first_sequence INTEGER NOT NULL,
                sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL
              )`;
              yield* sql`CREATE TABLE item_event_outbox (
                event_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
                format INTEGER NOT NULL, event TEXT NOT NULL
              )`;
              yield* sql`CREATE TABLE event_sequence (
                id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL
              )`;
              yield* sql`INSERT INTO event_sequence SELECT 1, COALESCE(MAX(sequence), 0) FROM events`;
              yield* sql`CREATE TRIGGER events_high_water AFTER INSERT ON events BEGIN
                UPDATE event_sequence SET sequence = MAX(sequence, NEW.sequence) WHERE id = 1;
              END`;
              yield* sql`CREATE TABLE item_history_normalization (
                id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL, done INTEGER NOT NULL
              )`;
              yield* sql`INSERT INTO item_history_normalization VALUES (1, 0, 0)`;

              const committed = yield* Deferred.make<void>();
              // Observe after the page transaction commits, then interrupt before page two.
              const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
                sql.withTransaction(effect).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      const [state] = yield* sql<{ cursor: number }>`
                        SELECT cursor FROM signalbox_turn_item_backfill WHERE id = 1
                      `;
                      if (state?.cursor === 100) {
                        yield* Deferred.succeed(committed, undefined);
                        return yield* Effect.never;
                      }
                    }),
                  ),
                );
              const interruptedSql = new Proxy(sql, {
                get: (target, key, receiver) =>
                  key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
              });
              const backfilling = yield* Effect.gen(function* () {
                const freshStore = yield* ThreadStore.ThreadStore;
                yield* freshStore.initialize;
              }).pipe(
                Effect.provide(
                  Layer.fresh(ThreadStore.layer).pipe(
                    Layer.provide(Layer.succeed(SqlClient.SqlClient, interruptedSql)),
                  ),
                ),
                Effect.forkChild,
              );
              yield* Deferred.await(committed);
              yield* Fiber.interrupt(backfilling);

              expect(yield* sql`SELECT cursor FROM signalbox_turn_item_backfill`).toEqual([
                { cursor: 100 },
              ]);
              expect(
                yield* sql`SELECT first_sequence, sequence, ordinal, event
                  FROM signalbox_turn_item_state WHERE item_id = ${toolId}`,
              ).toEqual([
                {
                  first_sequence: head + 1,
                  sequence: 100,
                  ordinal: 100,
                  event: expect.any(String),
                },
              ]);
              const [partial] = yield* sql<{ readonly event: string }>`
                SELECT event FROM signalbox_turn_item_state WHERE item_id = ${toolId}
              `;
              expect(commandOutput(decodeEvent(partial?.event))).toBe(`partial:${99 - head}`);
              expect(
                yield* sql`SELECT sequence, format, event FROM events ORDER BY sequence`,
              ).toEqual(legacyLog);
              expect(
                yield* sql`SELECT COUNT(*) AS count FROM events
                  WHERE json_extract(event, '$.payload.id') = ${toolId}`,
              ).toEqual([{ count: 204 }]);
              expect(yield* store.eventsDelivered).toBe(head);
              return { head, finalOutput, legacyLog };
            }),
        );

        // Reopening the same SQLite file resumes from the durable cursor.
        yield* withObject(filename, user.users, ({ engine, store, sql }) =>
          Effect.gen(function* () {
            expect(yield* sql`SELECT cursor FROM signalbox_turn_item_backfill`).toEqual([
              { cursor: head + 205 },
            ]);
            const canonical = yield* sql<{
              readonly item_id: string;
              readonly first_sequence: number;
              readonly sequence: number;
              readonly ordinal: number;
              readonly event: string;
            }>`SELECT item_id, first_sequence, sequence, ordinal, event
              FROM signalbox_turn_item_state ORDER BY first_sequence`;
            expect(
              canonical
                .filter(({ item_id }) => item_id === toolId || item_id === secondToolId)
                .map(({ item_id, first_sequence, sequence, ordinal }) => [
                  item_id,
                  first_sequence,
                  sequence,
                  ordinal,
                ]),
            ).toEqual([
              [toolId, head + 1, head + 205, 100],
              [secondToolId, head + 2, head + 2, 200],
            ]);
            const toolCanonical = canonical.find(({ item_id }) => item_id === toolId);
            const finalEvent = decodeEvent(toolCanonical?.event);
            expect(commandOutput(finalEvent)).toBe(finalOutput);
            expect(
              finalEvent.type === "turn-item.updated" ? finalEvent.payload.ordinal : null,
            ).toBe(100);

            const logAfterRestart = yield* sql<{
              readonly sequence: number;
              readonly format: number;
              readonly event: string;
            }>`SELECT sequence, format, event FROM events ORDER BY sequence`;
            expect(logAfterRestart).toEqual(legacyLog);
            const rows = yield* store.events(head);
            expect(rows).toHaveLength(205);
            expect(rows.map((row) => row.sequence)).toEqual(
              Array.from({ length: 205 }, (_, index) => head + index + 1),
            );
            expect(commandOutput(rows.at(-1)?.event)).toBe(finalOutput);

            const snapshot = yield* engine.snapshot(owner);
            expect(snapshot.snapshotSequence).toBe(head + 205);
            expect(
              snapshot.projection.turnItems
                .filter((item) => item.id === toolId || item.id === secondToolId)
                .map((item) => item.id),
            ).toEqual([toolId, secondToolId]);
            const pending = yield* engine.pendingEvents(500);
            expect(pending?.events).toHaveLength(205);
            expect(pending?.events.at(-1)?.sequence).toBe(head + 205);
            expect(commandOutput(pending?.events.at(-1)?.event)).toBe(finalOutput);
            expect(yield* store.eventsDelivered).toBe(head);

            yield* engine.acknowledgeEvents(head + 205);
            expect(yield* engine.pendingEvents(50)).toBeNull();
            expect(yield* store.events(head)).toEqual(rows);
          }),
        );
      });
    },
  );
});
