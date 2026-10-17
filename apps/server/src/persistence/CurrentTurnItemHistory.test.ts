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
  "resumes interrupted normalization after its first committed page with stable order and prompts",
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
      const committed = yield* Deferred.make<void>();
      // The gate runs after withTransaction has committed and released its connection.
      const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
        sql.withTransaction(effect).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              const [state] = yield* sql<{ phase: number; cursor: number }>`
            SELECT phase, cursor FROM signalbox_item_history_normalization WHERE id = 1
          `;
              if (state?.phase === 0 && state.cursor === 100) {
                yield* Deferred.succeed(committed, undefined);
                yield* Effect.never;
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
      assert.deepEqual(yield* sql`SELECT phase, cursor FROM signalbox_item_history_normalization`, [
        { phase: 0, cursor: 100 },
      ]);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`, [
        { count: 205 },
      ]);
      assert.deepEqual(
        yield* sql`SELECT first_sequence, sequence, ordinal FROM signalbox_current_turn_items ORDER BY first_sequence`,
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
      assert.lengthOf(replay, 2);
      assert.equal(yield* store.latestAgentSequence(threadId), before);
      assert.deepEqual(
        replay.map((stored) => stored.sequence),
        [2, 205],
      );
      for (const stored of replay) {
        assert.equal(stored.event.type, "turn-item.updated");
        if (stored.event.type !== "turn-item.updated" || stored.event.payload.type !== "subagent")
          return;
        assert.equal(stored.event.payload.prompt, prompt);
        assert.equal(stored.event.payload.ordinal, stored.sequence === 2 ? 18 : 17);
        assert.equal(
          stored.event.payload.progress,
          stored.sequence === 2 ? "starting" : "progress:204",
        );
      }
      const [stats] = yield* sql<{ rows: number; bytes: number; refs: number }>`
      SELECT COUNT(*) AS rows, SUM(length(payload_json)) AS bytes,
        SUM(json_type(payload_json, '$.promptSequence') IS NOT NULL) AS refs
      FROM orchestration_events
    `;
      assert.equal(stats?.rows, 2);
      assert.equal(stats?.refs, 0);
      assert.isBelow(stats!.bytes, prompt.length * 2 + 2000);
      assert.deepEqual(
        yield* sql`SELECT first_sequence, ordinal FROM signalbox_current_turn_items ORDER BY first_sequence`,
        [
          { first_sequence: 1, ordinal: 17 },
          { first_sequence: 2, ordinal: 18 },
        ],
      );
      yield* initializeCurrentTurnItemHistory;
      const restarted = yield* Effect.gen(function* () {
        const fresh = yield* OrchestrationEventStore.OrchestrationEventStore;
        return yield* fresh.readAgentEvents().pipe(Stream.runCollect);
      }).pipe(Effect.provide(Layer.fresh(OrchestrationEventStore.layer)));
      assert.deepEqual(restarted, replay);
      const last = replay[1]!;
      const [next] = yield* store.appendAgentEvents({
        events: [{ ...last.event, id: EventId.make("after-upgrade") }],
      });
      assert.isAbove(next!.sequence, before);
      assert.lengthOf(yield* store.readAgentEvents().pipe(Stream.runCollect), 2);
      assert.deepEqual(
        yield* store.readAgentEvents({ afterSequence: 204 }).pipe(Stream.runCollect),
        [next],
      );
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
);
