import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const ACTION_RETRY_BASE_MS = 5_000;
const ACTION_RETRY_MAX_MS = 300_000;
const MAX_ACTION_RETRY_ATTEMPTS = 7;

const actionRetryDelay = (attempts: number) =>
  Math.min(ACTION_RETRY_BASE_MS * 2 ** (attempts - 1), ACTION_RETRY_MAX_MS);

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
    yield* sql`CREATE TABLE IF NOT EXISTS sbx_level_learner_668_action_retries (
      action_event_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      attempted_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS sbx_level_learner_668_action_retry_due
      ON sbx_level_learner_668_action_retries (next_attempt_at, attempted_at)`;
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

/** Keep every unpaired action retryable, while spacing repeated Jev failures. */
export const recordActionRetry = (
  sql: SqlClient.SqlClient,
  actionEventId: string,
  attemptedAt: number,
): Effect.Effect<void, SqlError> =>
  sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{ attempts: number }>`SELECT attempts
        FROM sbx_level_learner_668_action_retries WHERE action_event_id = ${actionEventId}`;
      const attempts = Math.min((rows[0]?.attempts ?? 0) + 1, MAX_ACTION_RETRY_ATTEMPTS);
      const nextAttemptAt = attemptedAt + actionRetryDelay(attempts);
      yield* sql`INSERT INTO sbx_level_learner_668_action_retries
        (action_event_id, attempts, attempted_at, next_attempt_at)
        SELECT e.event_id, ${attempts}, ${attemptedAt}, ${nextAttemptAt}
        FROM sbx_level_learner_668_events e WHERE e.event_id = ${actionEventId}
          AND e.kind = 'human_action'
          AND NOT EXISTS (SELECT 1 FROM sbx_level_learner_668_revoked_trees r
            WHERE r.tree_id = e.tree_id)
          AND NOT EXISTS (SELECT 1 FROM sbx_level_learner_668_precedents p
            WHERE p.action_event_id = e.event_id)
        ON CONFLICT(action_event_id) DO UPDATE SET attempts = excluded.attempts,
          attempted_at = excluded.attempted_at, next_attempt_at = excluded.next_attempt_at`;
    }),
  );

export const clearActionRetry = (sql: SqlClient.SqlClient, actionEventId: string) =>
  sql`DELETE FROM sbx_level_learner_668_action_retries
    WHERE action_event_id = ${actionEventId}`.pipe(Effect.asVoid);

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
    yield* sql`DELETE FROM sbx_level_learner_668_action_retries
      WHERE action_event_id IN (
        SELECT event_id FROM sbx_level_learner_668_events WHERE tree_id = ${treeId}
      )`;
    yield* sql`DELETE FROM sbx_level_learner_668_events WHERE tree_id = ${treeId}`;
    yield* sql`DELETE FROM sbx_level_learner_668_settings WHERE tree_id = ${treeId}`;
  });
