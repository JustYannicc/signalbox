import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** Cloud user objects and their folders all keep independent SQLite learner rows. */
export const createTables = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_revoked_trees (
      tree_id TEXT PRIMARY KEY
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_events (
      event_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tree_id TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      input TEXT,
      object_id TEXT,
      used_lens_id TEXT,
      occurred_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS sbx_level_learner_668_event_scope
      ON sbx_level_learner_668_events (scope, kind, occurred_at)`;
    yield* sql`CREATE INDEX IF NOT EXISTS sbx_level_learner_668_event_object
      ON sbx_level_learner_668_events (scope, object_id, kind)`;
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_precedents (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tree_id TEXT NOT NULL,
      draft_tree_id TEXT NOT NULL,
      action_tree_id TEXT NOT NULL,
      draft_event_id TEXT NOT NULL,
      action_event_id TEXT NOT NULL,
      source TEXT NOT NULL,
      input TEXT NOT NULL,
      draft TEXT NOT NULL,
      action TEXT NOT NULL,
      classification TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (draft_event_id, action_event_id)
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS sbx_level_learner_668_precedent_scope
      ON sbx_level_learner_668_precedents (scope, created_at)`;
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_lenses (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      tree_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reason TEXT NOT NULL,
      condition_text TEXT,
      expected_action TEXT,
      seed_precedent_id TEXT,
      owner_stated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS sbx_level_learner_668_owner_statement
      ON sbx_level_learner_668_lenses (scope, tree_id, text) WHERE owner_stated = 1`;
    yield* sql`CREATE INDEX IF NOT EXISTS sbx_level_learner_668_lens_scope
      ON sbx_level_learner_668_lenses (scope, created_at)`;
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_evidence (
      lens_id TEXT NOT NULL,
      precedent_id TEXT NOT NULL,
      tree_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      PRIMARY KEY (lens_id, precedent_id)
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS sbx_level_learner_668_evidence_lens
      ON sbx_level_learner_668_evidence (lens_id, occurred_at)`;
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_settings (
      scope TEXT PRIMARY KEY,
      tree_id TEXT NOT NULL,
      settings_json TEXT NOT NULL
    )`;
  });

/**
 * Removes source rows and every derived contribution made by a tree. Stats are
 * projections over evidence rows, so deleting evidence also recomputes them.
 */
export const deleteTreeContributions = (
  sql: SqlClient.SqlClient,
  treeId: string,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    yield* createTables(sql);
    yield* sql`INSERT INTO sbx_level_learner_668_revoked_trees (tree_id)
      VALUES (${treeId}) ON CONFLICT(tree_id) DO NOTHING`;
    yield* sql`DELETE FROM sbx_level_learner_668_evidence
      WHERE lens_id IN (
        SELECT id FROM sbx_level_learner_668_lenses WHERE tree_id = ${treeId}
      ) OR tree_id = ${treeId} OR precedent_id IN (
        SELECT id FROM sbx_level_learner_668_precedents
        WHERE draft_tree_id = ${treeId} OR action_tree_id = ${treeId}
      )`;
    yield* sql`DELETE FROM sbx_level_learner_668_lenses
      WHERE tree_id = ${treeId} OR seed_precedent_id IN (
        SELECT id FROM sbx_level_learner_668_precedents
        WHERE draft_tree_id = ${treeId} OR action_tree_id = ${treeId}
      )`;
    yield* sql`DELETE FROM sbx_level_learner_668_precedents
      WHERE tree_id = ${treeId} OR draft_tree_id = ${treeId} OR action_tree_id = ${treeId}`;
    yield* sql`DELETE FROM sbx_level_learner_668_events WHERE tree_id = ${treeId}`;
    yield* sql`DELETE FROM sbx_level_learner_668_settings WHERE tree_id = ${treeId}`;
  });

/** A new membership permits fresh contributions; it never restores deleted learning. */
export const allowTreeContributions = (sql: SqlClient.SqlClient, treeId: string) =>
  Effect.gen(function* () {
    yield* createTables(sql);
    yield* sql`DELETE FROM sbx_level_learner_668_revoked_trees WHERE tree_id = ${treeId}`;
  });
