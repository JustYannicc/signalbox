import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { initializeCurrentTurnItemHistory } from "./CurrentTurnItemHistory.ts";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

const testLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const threadId = ThreadId.make("legacy-current-items");
const at = "2026-10-17T00:00:00.000Z";
const prompt = "Synthetic prompt ".repeat(500);
const item = (id: string, ordinal: number) => ({
  id,
  type: "subagent",
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "running",
  title: "Synthetic subagent",
  subagentId: `node:${id}`,
  origin: "provider_native",
  driver: "codex",
  providerInstanceId: "codex",
  childThreadId: null,
  prompt,
  progress: "starting",
  result: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
});

it.effect(
  "resumes additive backfill after a committed page and reconciles rollback writes without changing history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* runMigrations();
      const rows = Array.from({ length: 205 }, (_, index) => ({
        event_id: `legacy:${index}`,
        aggregate_kind: "thread",
        stream_id: threadId,
        stream_version: index,
        event_type: "turn-item.updated",
        occurred_at: at,
        command_id: null,
        causation_event_id: null,
        correlation_id: null,
        actor_kind: "provider",
        metadata_json: "{}",
        application_event_version: 2,
        payload_json: JSON.stringify(
          index === 1
            ? item("second", 18)
            : {
                ...item("first", index === 0 ? 17 : 999),
                progress: `progress:${index}`,
                ...(index === 0 ? {} : { prompt: "", promptSequence: 1 }),
              },
        ),
      }));
      yield* sql`INSERT INTO orchestration_events ${sql.insert(rows)}`;
      const before = yield* store.latestAgentSequence(threadId);
      const originalRows = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      const committed = yield* Deferred.make<void>();
      // The gate runs after withTransaction has committed and released its connection.
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
      const normalizing = yield* initializeCurrentTurnItemHistory.pipe(
        Effect.provideService(SqlClient.SqlClient, interruptedSql),
        Effect.forkChild,
      );
      yield* Deferred.await(committed);
      yield* Fiber.interrupt(normalizing);
      assert.deepEqual(yield* sql`SELECT cursor FROM signalbox_turn_item_backfill`, [
        { cursor: 100 },
      ]);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`, [
        { count: 205 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT first_sequence, sequence, ordinal FROM signalbox_turn_item_state ORDER BY first_sequence`,
        [
          { first_sequence: 1, sequence: 100, ordinal: 17 },
          { first_sequence: 2, sequence: 2, ordinal: 18 },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT json_extract(payload_json, '$.prompt') AS prompt FROM orchestration_events WHERE sequence = 1`,
        [{ prompt }],
      );
      assert.equal(yield* store.latestAgentSequence(threadId), before);

      const replay = yield* Effect.gen(function* () {
        yield* initializeCurrentTurnItemHistory;
        const resumedStore = yield* OrchestrationEventStore.OrchestrationEventStore;
        return yield* resumedStore.readAgentEvents({ threadId }).pipe(Stream.runCollect);
      }).pipe(Effect.provide(Layer.fresh(OrchestrationEventStore.layer)));
      assert.lengthOf(replay, 205);
      assert.equal(yield* store.latestAgentSequence(threadId), before);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        originalRows,
      );
      const expected = [
        {
          item_id: "first",
          first_sequence: 1,
          sequence: 205,
          ordinal: 17,
          prompt,
          progress: "progress:204",
        },
        {
          item_id: "second",
          first_sequence: 2,
          sequence: 2,
          ordinal: 18,
          prompt,
          progress: "starting",
        },
      ];
      const currentItems = sql`
        SELECT item_id, first_sequence, sequence, ordinal,
          json_extract(payload_json, '$.prompt') AS prompt,
          json_extract(payload_json, '$.progress') AS progress
        FROM signalbox_turn_item_state ORDER BY first_sequence
      `;
      assert.deepEqual(yield* currentItems, expected);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM signalbox_turn_item_state`, [
        { count: 2 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS refs FROM signalbox_turn_item_state
        WHERE json_type(payload_json, '$.promptSequence') IS NOT NULL`,
        [{ refs: 0 }],
      );

      // This is the unchanged old writer's SQL shape: only orchestration_events,
      // including its promptSequence anchor. It knows nothing about the side table.
      yield* sql`INSERT INTO orchestration_events ${sql.insert({
        ...rows[204]!,
        event_id: "rollback-writer",
        stream_version: 205,
        payload_json: JSON.stringify({
          ...item("first", 17),
          prompt: "",
          promptSequence: 1,
          progress: "rollback final output",
        }),
      })}`;
      assert.deepEqual(yield* currentItems, expected);
      assert.equal(yield* store.latestAgentSequence(threadId), 206);
      const rollbackRows = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      yield* Effect.gen(function* () {
        yield* initializeCurrentTurnItemHistory;
        const restarted = yield* OrchestrationEventStore.OrchestrationEventStore;
        const restored = yield* restarted
          .readAgentEvents({ afterSequence: 205 })
          .pipe(Stream.runCollect);
        assert.lengthOf(restored, 1);
        const event = restored[0]!.event;
        assert.equal(event.type, "turn-item.updated");
        if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") return;
        assert.equal(event.payload.prompt, prompt);
        assert.equal(event.payload.progress, "rollback final output");
      }).pipe(Effect.provide(Layer.fresh(OrchestrationEventStore.layer)));
      assert.deepEqual(yield* currentItems, [
        { ...expected[0]!, sequence: 206, progress: "rollback final output" },
        expected[1]!,
      ]);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        rollbackRows,
      );
      assert.deepEqual(yield* sql`SELECT cursor FROM signalbox_turn_item_backfill`, [
        { cursor: 206 },
      ]);
      yield* initializeCurrentTurnItemHistory;
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
        rollbackRows,
      );
      const last = replay.at(-1)!;
      const [next] = yield* store.appendAgentEvents({
        events: [{ ...last.event, id: EventId.make("after-resume") }],
      });
      assert.equal(next!.sequence, 207);
      assert.deepEqual(
        yield* sql`SELECT sequence FROM signalbox_turn_item_state WHERE item_id = 'first'`,
        [{ sequence: 207 }],
      );
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);
