import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The legacy log remains authoritative throughout expansion. Only this side row
// hydrates prompt references; old readers still see the original bytes/anchors.
const copyCurrentItem = Effect.fnUntraced(function* (sequence: number, firstSequence = sequence) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO signalbox_turn_item_state (
      thread_id, item_id, first_sequence, sequence, ordinal,
      event_id, command_id, occurred_at, payload_json, metadata_json
    )
    SELECT source.stream_id, json_extract(source.payload_json, '$.id'), ${firstSequence}, source.sequence,
      COALESCE(current.ordinal, position.ordinal, json_extract(first.payload_json, '$.ordinal')),
      source.event_id, source.command_id, source.occurred_at,
      json_set(
        CASE WHEN json_type(source.payload_json, '$.promptSequence') = 'integer'
          THEN json_set(json_remove(source.payload_json, '$.promptSequence'), '$.prompt',
            (SELECT json_extract(anchor.payload_json, '$.prompt') FROM orchestration_events AS anchor
             WHERE anchor.sequence = json_extract(source.payload_json, '$.promptSequence')))
          ELSE source.payload_json END,
        '$.ordinal', COALESCE(current.ordinal, position.ordinal, json_extract(first.payload_json, '$.ordinal'))
      ), source.metadata_json
    FROM orchestration_events AS source
    JOIN orchestration_events AS first ON first.sequence = ${firstSequence}
    LEFT JOIN signalbox_turn_item_state AS current
      ON current.thread_id = source.stream_id AND current.item_id = json_extract(source.payload_json, '$.id')
    LEFT JOIN orchestration_v2_turn_item_positions AS position
      ON position.thread_id = source.stream_id AND position.turn_item_id = json_extract(source.payload_json, '$.id')
    WHERE source.sequence = ${sequence} AND source.application_event_version = 2
      AND source.aggregate_kind = 'thread' AND source.event_type = 'turn-item.updated'
    ON CONFLICT(thread_id, item_id) DO UPDATE SET
      sequence = excluded.sequence, event_id = excluded.event_id, command_id = excluded.command_id,
      occurred_at = excluded.occurred_at, payload_json = excluded.payload_json, metadata_json = excluded.metadata_json
    WHERE excluded.sequence > signalbox_turn_item_state.sequence
  `;
});

export const recordCurrentTurnItem = Effect.fnUntraced(function* (
  stored: OrchestrationV2StoredEvent,
) {
  if (stored.event.type === "turn-item.updated") yield* copyCurrentItem(stored.sequence);
  return stored;
});

export const initializeCurrentTurnItemHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Distinct names also work on previews that ran the abandoned destructive draft.
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_turn_item_state (
    thread_id TEXT NOT NULL, item_id TEXT NOT NULL, first_sequence INTEGER NOT NULL,
    sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL, event_id TEXT NOT NULL,
    command_id TEXT, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, item_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_turn_item_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO signalbox_turn_item_backfill VALUES (1, 0)`;
  while (true) {
    const done = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [state] = yield* sql<{
          cursor: number;
        }>`SELECT cursor FROM signalbox_turn_item_backfill WHERE id = 1`;
        const cursor = state?.cursor ?? 0;
        const page = yield* sql<{ sequence: number }>`
        SELECT sequence FROM orchestration_events WHERE sequence > ${cursor} ORDER BY sequence LIMIT 100
      `;
        const end = page.at(-1)?.sequence;
        if (end === undefined) return true;
        // Copy only each page's latest payload, not every streamed snapshot/prompt.
        const items = yield* sql<{ first_sequence: number; sequence: number }>`
        SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS sequence FROM orchestration_events
        WHERE sequence > ${cursor} AND sequence <= ${end} AND application_event_version = 2
          AND aggregate_kind = 'thread' AND event_type = 'turn-item.updated'
        GROUP BY stream_id, json_extract(payload_json, '$.id')
      `;
        for (const item of items) yield* copyCurrentItem(item.sequence, item.first_sequence);
        yield* sql`UPDATE signalbox_turn_item_backfill SET cursor = ${end} WHERE id = 1`;
        return page.length < 100;
      }),
    );
    if (done) break;
    yield* Effect.yieldNow;
  }
  // No completed flag: an old writer may append while this version is rolled back.
});
