import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { ServedModel } from "./cliProxyApi.ts";

/**
 * The models a pool's CLIProxyAPI last said it serves, kept in the pool's
 * object next to its accounts and read on the same cadence, so the picker and
 * the check at turn start never wake a sleeping container.
 */

/** `PoolEngine`'s `0004` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE models (
    id TEXT PRIMARY KEY,
    owned_by TEXT NOT NULL,
    created INTEGER
  )`;
  // 0 until the first read: an empty list then means "not read yet", not "serves nothing".
  yield* sql`ALTER TABLE accounts_state ADD COLUMN models_checked_at INTEGER NOT NULL DEFAULT 0`;
});

export interface PoolModels {
  /** When the list was last read; 0 before the first read. */
  readonly checkedAt: number;
  readonly models: ReadonlyArray<ServedModel>;
}

export const cached = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly id: string;
    readonly owned_by: string;
    readonly created: number | null;
  }>`SELECT id, owned_by, created FROM models ORDER BY id`;
  const [state] = yield* sql<{
    readonly models_checked_at: number;
  }>`SELECT models_checked_at FROM accounts_state WHERE id = 1`;
  return {
    checkedAt: state?.models_checked_at ?? 0,
    models: rows.map((row): ServedModel => ({
      id: row.id,
      ownedBy: row.owned_by,
      created: row.created,
    })),
  } satisfies PoolModels;
});

/** Replaces the list, writing only when it changed. */
export const store = (models: ReadonlyArray<ServedModel>, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* cached;
    const key = (list: ReadonlyArray<ServedModel>) =>
      list
        .map((model) => `${model.id}\u0000${model.ownedBy}\u0000${model.created ?? ""}`)
        .toSorted()
        .join("\u0001");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (key(before.models) !== key(models)) {
          yield* sql`DELETE FROM models`;
          for (const model of models) {
            yield* sql`INSERT INTO models (id, owned_by, created)
              VALUES (${model.id}, ${model.ownedBy}, ${model.created})
              ON CONFLICT (id) DO NOTHING`;
          }
        }
        yield* sql`UPDATE accounts_state SET models_checked_at = ${now} WHERE id = 1`;
      }),
    );
  });

/**
 * After a failed first read: the list stays empty but counts as read, so a
 * CLIProxyAPI that never answers isn't woken on every look at the pool.
 */
export const markTried = (now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE accounts_state SET models_checked_at = ${now}
      WHERE id = 1 AND models_checked_at = 0`;
  });

/** Forgets the list, as when the pool switches to another CLIProxyAPI. */
export const clear = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM models`;
  yield* sql`UPDATE accounts_state SET models_checked_at = 0 WHERE id = 1`;
});
