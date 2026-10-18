import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `UserStore`'s `0019` migration: the user's notes (`UserNotes`). Additive:
 * new tables only. `folder_id` null is the top level; `reading` is the
 * contract's `NoteReading` as JSON, null until read.
 */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    folder_id TEXT,
    author_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reading TEXT,
    accepted_thread_id TEXT
  )`;
  // A pad newest first: the context of a read, and the notes of a thread's chain.
  yield* sql`CREATE INDEX notes_folder ON notes (folder_id, created_at)`;
  yield* sql`CREATE TABLE notes_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO notes_state (id, revision) VALUES (1, 0)`;
});
