import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * `UserStore`'s `0013` migration: folders (`UserFolders`), and everything
 * sections held, as folders. Additive: new tables, and rows only in them.
 * Sections keep their ids, so pools placed at them still apply. Drives get
 * their folders when `UserFolders` first reads the tree, once per drive
 * (`folder_drives`), since only code can tell a drive's owner.
 */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    drive_id TEXT,
    instructions TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX folders_drive ON folders (drive_id)`;
  // Drives that got their own folder once, so taking its files away never makes another.
  yield* sql`CREATE TABLE folder_drives (drive_id TEXT PRIMARY KEY)`;
  yield* sql`CREATE TABLE thread_homes (
    thread_id TEXT PRIMARY KEY,
    folder_id TEXT,
    filed_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE folders_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    instructions TEXT
  )`;
  yield* sql`INSERT INTO folders_state (id, revision) VALUES (1, 0)`;
  yield* sql`INSERT INTO folders (id, owner_id, parent_id, name, position)
    SELECT id, context_id, parent_id, name, position FROM sections`;
  // A My Drive placed in a section had its threads there; a drive's follow its folder.
  yield* sql`INSERT INTO thread_homes (thread_id, folder_id, filed_at)
    SELECT thread_index.thread_id, project_placements.section_id, 0
    FROM thread_index JOIN project_placements
      ON project_placements.project_id = json_extract(thread_index.shell, '$.projectId')
    WHERE project_placements.section_id IS NOT NULL
      AND project_placements.project_id NOT LIKE 'drive:%'`;
});

/**
 * `UserStore`'s `0015` migration, with the user's 1Password account
 * (`OnePasswordAccount`): each level's 1Password Environment (#395), a
 * reference only, never a value.
 */
export const addSecrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE folders ADD COLUMN secrets_environment_id TEXT`;
  yield* sql`ALTER TABLE folders_state ADD COLUMN secrets_environment_id TEXT`;
});

/** `UserStore`'s `0021_folder_secret_subfolders` migration; empty until a source opts in. */
export const addSecretSubfolders = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE folders ADD COLUMN secrets_include_subfolders TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE folders_state ADD COLUMN secrets_include_subfolders TEXT NOT NULL DEFAULT '[]'`;
});

/** `UserStore`'s `0020` migration: each folder's phase (#677), its list as JSON and the current one. */
export const addPhases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE folders ADD COLUMN phases TEXT`;
  yield* sql`ALTER TABLE folders ADD COLUMN phase TEXT`;
});
