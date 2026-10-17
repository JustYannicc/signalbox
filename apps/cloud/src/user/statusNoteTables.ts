import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `UserStore`'s `0019` migration: each thread's latest status note (#670) as
 * its summary delivered it (`UserThreadStatus`). `written_at` orders notes, so
 * a redelivered older summary never replaces a newer note.
 */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_status_notes (
    thread_id TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    written_at INTEGER NOT NULL
  )`;
});
