import { TerminalEvent, type TerminalSessionSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const MAX_BATCH_EVENTS = 128;
const MAX_BATCH_BYTES = 512 * 1024;
const MAX_QUEUED_TERMINAL_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const json = Schema.fromJsonString(TerminalEvent);
const encode = Schema.encodeSync(json);
const encodedSize = (event: TerminalEvent) => encoder.encode(encode(event)).byteLength;
const decodeOutboxRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      sequence: Schema.Number,
      event: json,
    }),
  ),
);
const decodeQueuedBytes = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ bytes: Schema.Number })),
);

export class TerminalOutbox extends Context.Service<
  TerminalOutbox,
  {
    readonly append: (
      event: TerminalEvent,
      snapshot: TerminalSessionSnapshot,
      hasRunningSubprocess?: boolean,
    ) => Effect.Effect<void, SqlError | Schema.SchemaError>;
    readonly pending: Effect.Effect<
      {
        readonly sequence: number;
        readonly events: ReadonlyArray<TerminalEvent>;
      } | null,
      SqlError | Schema.SchemaError
    >;
    readonly acknowledge: (sequence: number) => Effect.Effect<void, SqlError>;
    readonly hasPending: Effect.Effect<boolean, SqlError>;
  }
>()("@signalbox/cloud/thread/terminal/TerminalOutbox") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // This sequence never resets when acknowledged rows are deleted.
  yield* sql`CREATE TABLE IF NOT EXISTS cloud_terminal_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    terminal_id TEXT NOT NULL,
    event TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS cloud_terminal_outbox_terminal
    ON cloud_terminal_outbox (terminal_id)`;
  const insert = (event: TerminalEvent) =>
    sql`INSERT INTO cloud_terminal_outbox (terminal_id, event)
      VALUES (${event.terminalId}, ${encode(event)})`.pipe(Effect.asVoid);
  const compactSnapshot = (snapshot: TerminalSessionSnapshot, maxBytes: number): TerminalEvent => {
    const text = Array.from(snapshot.history);
    const eventAt = (start: number): TerminalEvent => ({
      type: "started",
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      sequence: snapshot.sequence,
      snapshot: { ...snapshot, history: text.slice(start).join("") },
    });
    if (encodedSize(eventAt(0)) <= maxBytes) return eventAt(0);

    // JSON escaping can make terminal control bytes much larger than their UTF-8 size.
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (encodedSize(eventAt(middle)) <= maxBytes) high = middle;
      else low = middle + 1;
    }
    return eventAt(low);
  };
  const append: TerminalOutbox["Service"]["append"] = (
    event,
    snapshot,
    hasRunningSubprocess = false,
  ) =>
    Effect.gen(function* () {
      const queued = yield* sql`SELECT COALESCE(SUM(LENGTH(CAST(event AS BLOB))), 0) AS bytes
        FROM cloud_terminal_outbox WHERE terminal_id = ${event.terminalId}`;
      const queuedBytes = yield* decodeQueuedBytes(queued).pipe(
        Effect.map((rows) => rows[0]?.bytes ?? 0),
      );
      if (queuedBytes + encodedSize(event) > MAX_QUEUED_TERMINAL_BYTES) {
        // An unavailable user object must not turn shell output into an unbounded queue.
        yield* sql`DELETE FROM cloud_terminal_outbox WHERE terminal_id = ${event.terminalId}`;
        if (event.type === "closed") return yield* insert(event);

        const activity: TerminalEvent = {
          type: "activity",
          threadId: snapshot.threadId,
          terminalId: snapshot.terminalId,
          hasRunningSubprocess,
          label: snapshot.label,
          ...(snapshot.sequence === undefined ? {} : { sequence: snapshot.sequence }),
        };
        const startedEvent = compactSnapshot(
          snapshot,
          MAX_QUEUED_TERMINAL_BYTES - encodedSize(activity),
        );
        yield* insert(startedEvent);
        // The session snapshot carries output, clear, exit, error and restart state.
        // Preserve the separate activity bit too, even when another event overflowed.
        yield* insert(activity);
        return;
      }
      yield* insert(event);
    });
  const pending: TerminalOutbox["Service"]["pending"] = Effect.flatMap(
    sql`SELECT sequence, event FROM cloud_terminal_outbox ORDER BY sequence LIMIT ${MAX_BATCH_EVENTS}`,
    (result) =>
      decodeOutboxRows(result).pipe(
        Effect.map((batch) => {
          const events: Array<TerminalEvent> = [];
          let sequence = 0;
          let bytes = 0;
          for (const row of batch) {
            const size = encodedSize(row.event);
            if (events.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
            events.push(row.event);
            sequence = row.sequence;
            bytes += size;
          }
          return events.length === 0 ? null : { sequence, events };
        }),
      ),
  );
  return TerminalOutbox.of({
    append,
    pending,
    acknowledge: (sequence) =>
      sql`DELETE FROM cloud_terminal_outbox WHERE sequence <= ${sequence}`.pipe(Effect.asVoid),
    hasPending: sql`SELECT 1 FROM cloud_terminal_outbox LIMIT 1`.pipe(
      Effect.map((result) => result.length > 0),
    ),
  });
});

export const layer = Layer.effect(TerminalOutbox, make.pipe(Effect.orDie));
