import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The latest sequence is the reconnect cursor; first_sequence and ordinal survive
// replacement so compaction never changes where an item first appeared.
export const retainCurrentTurnItem = Effect.fnUntraced(function* (
  stored: OrchestrationV2StoredEvent,
) {
  if (stored.event.type !== "turn-item.updated") return stored;
  const sql = yield* SqlClient.SqlClient;
  const item = stored.event.payload;
  const [previous] = yield* sql<{ sequence: number; ordinal: number }>`
    SELECT sequence, ordinal FROM signalbox_current_turn_items
    WHERE thread_id = ${stored.event.threadId} AND item_id = ${item.id}
  `;
  const ordinal = previous?.ordinal ?? item.ordinal;
  yield* sql`
    INSERT INTO signalbox_current_turn_items (thread_id, item_id, first_sequence, sequence, ordinal)
    VALUES (${stored.event.threadId}, ${item.id}, ${stored.sequence}, ${stored.sequence}, ${ordinal})
    ON CONFLICT(thread_id, item_id) DO UPDATE SET sequence = excluded.sequence
  `;
  if (previous !== undefined) {
    yield* sql`DELETE FROM orchestration_events WHERE sequence = ${previous.sequence}`;
  }
  if (ordinal === item.ordinal) return stored;
  yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.ordinal', ${ordinal}) WHERE sequence = ${stored.sequence}`;
  return { ...stored, event: { ...stored.event, payload: { ...item, ordinal } } };
});

export const initializeCurrentTurnItemHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS signalbox_current_turn_items (
      thread_id TEXT NOT NULL, item_id TEXT NOT NULL, first_sequence INTEGER NOT NULL,
      sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS signalbox_item_history_normalization (
      id INTEGER PRIMARY KEY CHECK (id = 1), phase INTEGER NOT NULL, cursor INTEGER NOT NULL
    )
  `;
  yield* sql`INSERT OR IGNORE INTO signalbox_item_history_normalization VALUES (1, 0, 0)`;

  // First index item identities, then hydrate only retained payloads, then delete.
  // Hydrating every old delta would temporarily multiply large prompts on disk.
  // Each committed page checkpoints its cursor for interrupted upgrades.
  while (true) {
    const done = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [state] = yield* sql<{ phase: number; cursor: number }>`
        SELECT phase, cursor FROM signalbox_item_history_normalization WHERE id = 1
      `;
        if (state === undefined || state.phase === 3) return true;
        const page = yield* sql<{ sequence: number }>`
        SELECT sequence FROM orchestration_events WHERE sequence > ${state.cursor}
        ORDER BY sequence LIMIT 100
      `;
        const end = page.at(-1)?.sequence;
        if (end === undefined) {
          yield* sql`UPDATE signalbox_item_history_normalization SET phase = ${state.phase + 1}, cursor = 0 WHERE id = 1`;
          return false;
        }
        if (state.phase === 0) {
          yield* sql`
          INSERT INTO signalbox_current_turn_items (thread_id, item_id, first_sequence, sequence, ordinal)
          SELECT stream_id, json_extract(payload_json, '$.id'), sequence, sequence,
            COALESCE((SELECT ordinal FROM orchestration_v2_turn_item_positions
              WHERE thread_id = stream_id AND turn_item_id = json_extract(payload_json, '$.id')),
              json_extract(payload_json, '$.ordinal'))
          FROM orchestration_events
          WHERE sequence > ${state.cursor} AND sequence <= ${end}
            AND application_event_version = 2 AND aggregate_kind = 'thread'
            AND event_type = 'turn-item.updated'
          ORDER BY sequence
          ON CONFLICT(thread_id, item_id) DO UPDATE SET sequence = excluded.sequence
        `;
        } else if (state.phase === 1) {
          yield* sql`
          UPDATE orchestration_events SET payload_json = json_set(
            CASE WHEN json_type(payload_json, '$.promptSequence') = 'integer'
              THEN json_set(json_remove(payload_json, '$.promptSequence'), '$.prompt',
                (SELECT json_extract(anchor.payload_json, '$.prompt') FROM orchestration_events AS anchor
                 WHERE anchor.sequence = json_extract(orchestration_events.payload_json, '$.promptSequence')))
              ELSE payload_json END,
            '$.ordinal', (SELECT ordinal FROM signalbox_current_turn_items
              WHERE thread_id = stream_id AND item_id = json_extract(payload_json, '$.id'))
          )
          WHERE sequence > ${state.cursor} AND sequence <= ${end}
            AND application_event_version = 2 AND aggregate_kind = 'thread'
            AND event_type = 'turn-item.updated'
            AND sequence = (SELECT sequence FROM signalbox_current_turn_items
              WHERE thread_id = stream_id AND item_id = json_extract(payload_json, '$.id'))
        `;
          yield* sql`
          UPDATE orchestration_events SET payload_json = json_set(
            json_remove(payload_json, '$.promptSequence'), '$.prompt',
            (SELECT json_extract(anchor.payload_json, '$.prompt') FROM orchestration_events AS anchor
             WHERE anchor.sequence = json_extract(orchestration_events.payload_json, '$.promptSequence'))
          )
          WHERE sequence > ${state.cursor} AND sequence <= ${end}
            AND application_event_version = 2 AND event_type = 'subagent.updated'
            AND json_type(payload_json, '$.promptSequence') = 'integer'
            AND EXISTS (SELECT 1 FROM orchestration_events AS anchor
              WHERE anchor.sequence = json_extract(orchestration_events.payload_json, '$.promptSequence')
                AND anchor.event_type = 'turn-item.updated')
        `;
        } else {
          yield* sql`
          DELETE FROM orchestration_events
          WHERE sequence > ${state.cursor} AND sequence <= ${end}
            AND application_event_version = 2 AND aggregate_kind = 'thread'
            AND event_type = 'turn-item.updated'
            AND sequence != (SELECT sequence FROM signalbox_current_turn_items
              WHERE thread_id = stream_id AND item_id = json_extract(payload_json, '$.id'))
        `;
        }
        yield* sql`UPDATE signalbox_item_history_normalization SET cursor = ${end} WHERE id = 1`;
        return false;
      }),
    );
    if (done) break;
    yield* Effect.yieldNow;
  }
});
