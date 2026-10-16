import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The thread store's `0010_browsing` migration: the browsing record as of
 * its latest event, and the recent events (`ThreadBrowsing.ts`).
 */
export const migrateBrowsing = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE browsing_events (
    sequence INTEGER PRIMARY KEY,
    event TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE browsing_record (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL,
    record TEXT NOT NULL
  )`;
});
