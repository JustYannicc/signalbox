import type { FolderId } from "@t3tools/contracts/signalboxFolders";
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

/**
 * A deleted folder's notes go up to its parent, as its threads do. Run in the
 * folder delete's transaction. A note landing at the top level becomes
 * private, and a team reading of one still on the pad goes with it: its
 * reader was the folder's agent, who can't see it anymore.
 */
export const moveNotesUp = (folderId: FolderId, parentId: FolderId | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const moving = yield* sql<{
      readonly n: number;
    }>`SELECT COUNT(*) AS n FROM notes WHERE folder_id = ${folderId}`;
    if ((moving[0]?.n ?? 0) === 0) return;
    if (parentId === null) {
      yield* sql`UPDATE notes SET visibility = 'private',
          reading = CASE WHEN visibility = 'team' AND accepted_thread_id IS NULL
            THEN NULL ELSE reading END
        WHERE folder_id = ${folderId}`;
    }
    yield* sql`UPDATE notes SET folder_id = ${parentId} WHERE folder_id = ${folderId}`;
    yield* sql`UPDATE notes_state SET revision = revision + 1 WHERE id = 1`;
  });
