import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `UserStore`'s `0018` migration: the person's sign-in grants (#575). A
 * revoked grant keeps its row, with who revoked it and when, so the record
 * shows what agents were allowed and until when. `source` is `person` or
 * `folder:<id>`; one grant per source and site is in force at a time.
 */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE sign_in_grants (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    site TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_by TEXT,
    revoked_at INTEGER
  )`;
  yield* sql`CREATE UNIQUE INDEX sign_in_grants_in_force
    ON sign_in_grants (source, site) WHERE revoked_at IS NULL`;
});
