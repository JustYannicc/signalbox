import {
  EventId,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const testLayer = OrchestrationEventStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const now = DateTime.makeUnsafe("2026-10-17T00:00:00Z");
const threadId = ThreadId.make("current-items");
function update(index: number, itemId = "command", ordinal = 1): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${itemId}:${index}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(itemId),
      type: "command_execution",
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: index === 99 ? "completed" : "running",
      title: "Synthetic output",
      input: "echo synthetic",
      output: "output line\n".repeat(index + 1),
      startedAt: now,
      completedAt: index === 99 ? now : null,
      updatedAt: now,
    },
  };
}

it.effect("retains one complete canonical item after 100 streamed updates with fresh cursors", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const emitted = [];
    for (let index = 0; index < 100; index++) {
      const [stored] = yield* store.appendAgentEvents({ events: [update(index)] });
      assert.ok(stored);
      emitted.push(stored);
    }
    const rows = yield* sql<{ count: number; bytes: number }>`
      SELECT COUNT(*) AS count, SUM(length(payload_json)) AS bytes FROM signalbox_turn_item_state
    `;
    assert.equal(rows[0]?.count, 1);
    assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`, [
      { count: 100 },
    ]);
    assert.deepEqual(
      yield* sql`SELECT json_extract(payload_json, '$.output') AS output FROM signalbox_turn_item_state`,
      [{ output: "output line\n".repeat(100) }],
    );
    assert.isBelow(rows[0]!.bytes, 2500);
    assert.equal(new Set(emitted.map((stored) => stored.sequence)).size, 100);
    const last = emitted[99]!;
    assert.equal(yield* store.latestAgentSequence(threadId), last.sequence);
    for (const cursor of [0, emitted[0]!.sequence, emitted[49]!.sequence, last.sequence]) {
      const replay = yield* store
        .readAgentEvents({ threadId, afterSequence: cursor })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        replay,
        emitted.filter((entry) => entry.sequence > cursor),
      );
    }
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("keeps distinct items and their original ordinals across interleaved updates", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const detached: OrchestrationV2DomainEvent = {
      id: EventId.make("session-detached"),
      type: "provider-session.detached",
      threadId,
      occurredAt: now,
      payload: { providerSessionId: ProviderSessionId.make("synthetic-session"), detachedAt: now },
    };
    yield* store.appendAgentEvents({
      events: [update(0, "first", 1), detached, update(0, "second", 2), update(99, "first", 1)],
    });
    const replay = yield* store.readAgentEvents({ threadId }).pipe(Stream.runCollect);
    assert.lengthOf(replay, 4);
    assert.deepEqual(
      replay.map((stored) => stored.event),
      [update(0, "first", 1), detached, update(0, "second", 2), update(99, "first", 1)],
    );
    assert.deepEqual(
      yield* store
        .readAgentEvents({ threadId, afterSequence: 2, throughSequence: 3 })
        .pipe(Stream.runCollect),
      [replay[2]],
    );
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);

it.effect("rolls dual writes back atomically and keeps the prior cursor and complete payload", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const initial = yield* store.appendAgentEvents({ events: [update(0)] });
    const attempt = yield* Effect.gen(function* () {
      yield* store.appendAgentEvents({ events: [update(1)] });
      return yield* Effect.fail("rollback");
    }).pipe(sql.withTransaction, Effect.result);
    assert.equal(attempt._tag, "Failure");
    assert.deepEqual(yield* store.readAgentEvents().pipe(Stream.runCollect), initial);
    const final = yield* store.appendAgentEvents({ events: [update(99)] });
    assert.deepEqual(yield* store.readAgentEvents().pipe(Stream.runCollect), [
      ...initial,
      ...final,
    ]);
    assert.isAbove(final[0]!.sequence, initial[0]!.sequence);
  }).pipe(Effect.provide(Layer.fresh(testLayer))),
);
