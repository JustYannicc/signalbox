import { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Where a thread object keeps its status note (#670): the note itself, which
 * its summary carries to the owner's index, and the runtime's cursor through
 * ended runs (`statusNotePolicy.ts`), so a note the agent left out is written
 * at least once per run however often the object is evicted.
 */

/**
 * The thread store's `0011_status_note` migration. A thread from before
 * starts its cursor at its latest run: notes cover turns from now on, so an
 * old thread waking up doesn't write one for its history.
 */
export const migrateStatusNote = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE status_note (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    note TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE status_note_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    through INTEGER NOT NULL,
    attempts_for INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    next_at INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO status_note_cursor (id, through, attempts_for, attempts, next_at)
    SELECT 1, COALESCE(MAX(json_extract(event, '$.payload.ordinal')), 0), 0, 0, 0
    FROM events WHERE json_extract(event, '$.type') = 'run.created'`;
});

const NoteJson = Schema.fromJsonString(Schema.toCodecJson(ThreadStatusNote));
const encodeNote = Schema.encodeSync(NoteJson);
const decodeNoteRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ note: NoteJson })));

export const readNote = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return decodeNoteRows(yield* sql`SELECT note FROM status_note WHERE id = 1`)[0]?.note ?? null;
});

export const writeNote = (note: ThreadStatusNote) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO status_note (id, note) VALUES (1, ${encodeNote(note)})
      ON CONFLICT (id) DO UPDATE SET note = excluded.note`;
  });

/**
 * Runs up to `through` (by ordinal) need nothing more; `attempts` failed
 * runtime writes for run `attemptsFor`, the next not before `nextAt`.
 */
export interface StatusNoteCursor {
  readonly through: number;
  readonly attemptsFor: number;
  readonly attempts: number;
  readonly nextAt: number;
}

const decodeCursorRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      through: Schema.Number,
      attempts_for: Schema.Number,
      attempts: Schema.Number,
      next_at: Schema.Number,
    }),
  ),
);

export const readCursor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = decodeCursorRows(
    yield* sql`SELECT through, attempts_for, attempts, next_at FROM status_note_cursor WHERE id = 1`,
  );
  return row === undefined
    ? null
    : ({
        through: row.through,
        attemptsFor: row.attempts_for,
        attempts: row.attempts,
        nextAt: row.next_at,
      } satisfies StatusNoteCursor);
});

export const writeCursor = (cursor: StatusNoteCursor) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO status_note_cursor (id, through, attempts_for, attempts, next_at)
      VALUES (1, ${cursor.through}, ${cursor.attemptsFor}, ${cursor.attempts}, ${cursor.nextAt})
      ON CONFLICT (id) DO UPDATE SET through = excluded.through,
        attempts_for = excluded.attempts_for, attempts = excluded.attempts,
        next_at = excluded.next_at`;
  });
