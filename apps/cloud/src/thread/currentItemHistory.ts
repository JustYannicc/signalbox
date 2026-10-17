import {
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const EventJson = Schema.fromJsonString(OrchestrationV2DomainEventJson);
const decode = Schema.decodeUnknownSync(EventJson);
const encode = Schema.encodeSync(EventJson);

const createCurrentItemExpansion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_turn_item_state (
    item_id TEXT PRIMARY KEY,
    first_sequence INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    format INTEGER NOT NULL,
    event TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_turn_item_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor INTEGER NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO signalbox_turn_item_backfill (id, cursor) VALUES (1, 0)`;
});

// Migration 0012 was used in preview with a destructive implementation. Keep
// its new definition additive, and repeat the schema in 0013 so previews that
// already recorded the old 0012 still receive the expansion tables.
export const migrateCurrentItemHistory = createCurrentItemExpansion;
export const migrateCurrentItemExpansion = createCurrentItemExpansion;

const withStableOrdinal = (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>,
  ordinal: number,
): OrchestrationV2DomainEvent =>
  event.payload.ordinal === ordinal ? event : { ...event, payload: { ...event.payload, ordinal } };

const storeCurrentItem = (
  sequence: number,
  firstSequence: number,
  ordinal: number,
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>,
) => {
  const stableEvent = withStableOrdinal(event, ordinal);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO signalbox_turn_item_state
      (item_id, first_sequence, sequence, ordinal, format, event)
      VALUES (${event.payload.id}, ${firstSequence}, ${sequence}, ${ordinal}, 1,
        ${encode(stableEvent)})
      ON CONFLICT (item_id) DO UPDATE SET
        first_sequence = MIN(signalbox_turn_item_state.first_sequence, excluded.first_sequence),
        ordinal = CASE
          WHEN excluded.first_sequence < signalbox_turn_item_state.first_sequence
          THEN excluded.ordinal ELSE signalbox_turn_item_state.ordinal END,
        sequence = CASE
          WHEN excluded.sequence > signalbox_turn_item_state.sequence
          THEN excluded.sequence ELSE signalbox_turn_item_state.sequence END,
        format = CASE
          WHEN excluded.sequence > signalbox_turn_item_state.sequence
          THEN excluded.format ELSE signalbox_turn_item_state.format END,
        event = CASE
          WHEN excluded.sequence > signalbox_turn_item_state.sequence THEN
            json_set(excluded.event, '$.payload.ordinal',
              CASE
                WHEN excluded.first_sequence < signalbox_turn_item_state.first_sequence
                THEN excluded.ordinal ELSE signalbox_turn_item_state.ordinal END)
          WHEN excluded.first_sequence < signalbox_turn_item_state.first_sequence THEN
            json_set(signalbox_turn_item_state.event, '$.payload.ordinal', excluded.ordinal)
          ELSE signalbox_turn_item_state.event END
      WHERE excluded.sequence > signalbox_turn_item_state.sequence
        OR excluded.first_sequence < signalbox_turn_item_state.first_sequence`;
  });
};

/** Add a current full payload while leaving the versioned event log untouched. */
export const recordCurrentItemState = Effect.fnUntraced(function* (
  sequence: number,
  event: OrchestrationV2DomainEvent,
) {
  if (event.type !== "turn-item.updated") return;
  const sql = yield* SqlClient.SqlClient;
  const [previous] = yield* sql<{ first_sequence: number; ordinal: number }>`
    SELECT first_sequence, ordinal FROM signalbox_turn_item_state
    WHERE item_id = ${event.payload.id}
  `;
  yield* storeCurrentItem(
    sequence,
    previous?.first_sequence ?? sequence,
    previous?.ordinal ?? event.payload.ordinal,
    event,
  );
});

// Backfill the additive table in committed pages. Each page copies only the
// latest full event per item; the old log remains byte-for-byte authoritative.
export const backfillCurrentItemState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const hasNextPage = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [state] = yield* sql<{ cursor: number }>`
          SELECT cursor FROM signalbox_turn_item_backfill WHERE id = 1
        `;
        if (state === undefined) return false;

        const page = yield* sql<{ sequence: number }>`
          SELECT sequence FROM events
          WHERE sequence > ${state.cursor}
          ORDER BY sequence LIMIT 100
        `;
        if (page.length === 0) return false;

        const firstPageSequence = page[0]!.sequence;
        const lastPageSequence = page.at(-1)!.sequence;
        const items = yield* sql<{
          readonly item_id: string;
          readonly first_sequence: number;
          readonly first_ordinal: number;
          readonly sequence: number;
          readonly format: number;
          readonly event: string;
        }>`
          WITH page AS (
            SELECT sequence, format, event FROM events
            WHERE sequence >= ${firstPageSequence} AND sequence <= ${lastPageSequence}
          ), item_bounds AS (
            SELECT json_extract(event, '$.payload.id') AS item_id,
              MIN(sequence) AS first_sequence, MAX(sequence) AS sequence
            FROM page
            WHERE format = 1
              AND json_extract(event, '$.type') = 'turn-item.updated'
            GROUP BY json_extract(event, '$.payload.id')
          )
          SELECT item_bounds.item_id, item_bounds.first_sequence,
            (SELECT json_extract(event, '$.payload.ordinal') FROM page
              WHERE sequence = item_bounds.first_sequence) AS first_ordinal,
            item_bounds.sequence, latest.format, latest.event
          FROM item_bounds
          JOIN events AS latest ON latest.sequence = item_bounds.sequence
          ORDER BY item_bounds.sequence
        `;

        for (const row of items) {
          if (row.format !== 1) continue;
          const event = decode(row.event);
          if (event.type === "turn-item.updated") {
            yield* storeCurrentItem(row.sequence, row.first_sequence, row.first_ordinal, event);
          }
        }

        yield* sql`UPDATE signalbox_turn_item_backfill
          SET cursor = ${lastPageSequence} WHERE id = 1`;
        return page.length === 100;
      }),
    );
    if (!hasNextPage) return;
    yield* Effect.yieldNow;
  }
});
