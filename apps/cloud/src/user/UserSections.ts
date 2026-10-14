import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The tables sections lived in before folders (#227). Nothing writes them
 * now: `0013` read them into folders (`folderTables.ts`), and older previews
 * still read them (`UserFolders.legacyRows`). Kept because `0004` creates
 * them, and a merged migration never changes.
 */

/** Part of `UserStore`'s `0004` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE project_placements (
    project_id TEXT PRIMARY KEY,
    section_id TEXT,
    position INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE sections_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO sections_state (id, revision) VALUES (1, 0)`;
});
