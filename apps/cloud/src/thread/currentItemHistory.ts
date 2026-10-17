import { itemCandidates } from "@signalbox/automations/events/turnItems";
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

export const migrateCurrentItemHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
});

function sameTodos(before: OrchestrationV2DomainEvent, after: OrchestrationV2DomainEvent) {
  if (
    before.type !== "turn-item.updated" ||
    after.type !== "turn-item.updated" ||
    before.payload.type !== "todo_list" ||
    after.payload.type !== "todo_list"
  )
    return false;
  return (
    JSON.stringify([before.payload.steps, before.payload.explanation]) ===
    JSON.stringify([after.payload.steps, after.payload.explanation])
  );
}

// Only pending semantic occurrences outlive replacement. Stable automation ids
// bound tool starts/completions to one row each. Distinct todo changes are queued
// until acknowledged; repeating their timestamp does not create another event.
export const retainCurrentItem = Effect.fnUntraced(function* (
  sequence: number,
  event: OrchestrationV2DomainEvent,
) {
  if (event.type !== "turn-item.updated") return;
  const sql = yield* SqlClient.SqlClient;
  const [previous] = yield* sql<{ sequence: number; ordinal: number }>`
    SELECT sequence, ordinal FROM current_turn_items WHERE item_id = ${event.payload.id}
  `;
  if (previous !== undefined && previous.sequence !== sequence) {
    const [pending] = yield* sql<{ event: string; format: number }>`
      SELECT event, format FROM events WHERE sequence = ${previous.sequence}
        AND sequence > (SELECT delivered FROM event_outbox WHERE id = 1)
    `;
    if (pending !== undefined) {
      if (pending.format !== 1) return yield* Effect.die(new Error("Unknown item event format."));
      const prior = decode(pending.event);
      if (prior.type === "turn-item.updated" && !sameTodos(prior, event)) {
        const currentIds = new Set(
          itemCandidates(event.id, event.payload).map((candidate) => candidate.id),
        );
        const candidates = itemCandidates(prior.id, prior.payload).filter(
          (candidate) => !currentIds.has(candidate.id),
        );
        if (candidates.length > 0) {
          const key = JSON.stringify(candidates.map((candidate) => candidate.id));
          // A tool start uses its input, never its growing output. Keep the
          // schema-valid envelope so the existing automation normalizer owns it.
          let delivery = prior;
          if (prior.payload.type === "command_execution" && prior.payload.status === "running") {
            const { output: _output, ...payload } = prior.payload;
            delivery = { ...prior, payload };
          }
          yield* sql`INSERT OR IGNORE INTO item_event_outbox (event_key, sequence, format, event)
            VALUES (${key}, ${previous.sequence}, ${pending.format}, ${encode(delivery)})`;
        }
      }
    }
    yield* sql`DELETE FROM events WHERE sequence = ${previous.sequence}`;
  }
  const ordinal = previous?.ordinal ?? event.payload.ordinal;
  yield* sql`INSERT INTO current_turn_items (item_id, first_sequence, sequence, ordinal)
    VALUES (${event.payload.id}, ${sequence}, ${sequence}, ${ordinal})
    ON CONFLICT (item_id) DO UPDATE SET sequence = excluded.sequence`;
  if (ordinal !== event.payload.ordinal) {
    yield* sql`UPDATE events SET event = json_set(event, '$.payload.ordinal', ${ordinal})
      WHERE sequence = ${sequence}`;
  }
});

// Outside the schema migration transaction: each page commits its progress and
// can resume after eviction. Only one item's full payload is read at a time.
export const normalizeCurrentItemHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const done = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [state] = yield* sql<{ cursor: number; done: number }>`
        SELECT cursor, done FROM item_history_normalization WHERE id = 1
      `;
        if (state === undefined || state.done === 1) return true;
        const page = yield* sql<{ sequence: number }>`
        SELECT sequence FROM events WHERE sequence > ${state.cursor} ORDER BY sequence LIMIT 100
      `;
        for (const row of page) {
          const [item] = yield* sql<{ event: string }>`SELECT event FROM events
          WHERE sequence = ${row.sequence} AND format = 1 AND json_extract(event, '$.type') = 'turn-item.updated'`;
          if (item !== undefined) yield* retainCurrentItem(row.sequence, decode(item.event));
          yield* Effect.yieldNow;
        }
        yield* sql`UPDATE item_history_normalization SET cursor = ${page.at(-1)?.sequence ?? state.cursor},
        done = ${page.length < 100 ? 1 : 0} WHERE id = 1`;
        return page.length < 100;
      }),
    );
    if (done) break;
    yield* Effect.yieldNow;
  }
});
