import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ServedModel } from "./cliProxyApi.ts";
import * as PoolModelDiscovery from "./poolModelDiscovery.ts";

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

/** `PoolEngine`'s `0009` migration. */
export const addMetadata = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE models ADD COLUMN display_name TEXT`;
  yield* sql`ALTER TABLE models ADD COLUMN provider TEXT`;
  yield* sql`ALTER TABLE models ADD COLUMN reasoning_efforts TEXT`;
  yield* sql`ALTER TABLE accounts_state ADD COLUMN models_attempted_at INTEGER NOT NULL DEFAULT 0`;
});

const ReasoningEffortsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeReasoningEfforts = Schema.decodeUnknownOption(ReasoningEffortsJson);
const encodeReasoningEfforts = Schema.encodeSync(ReasoningEffortsJson);
const decodeModelChannel = Schema.decodeUnknownOption(PoolModelDiscovery.ModelChannel);

export interface PoolModels {
  /** When the list was last read; 0 before the first read. */
  readonly checkedAt: number;
  /** When the latest read was attempted, including failed reads. */
  readonly attemptedAt: number;
  readonly models: ReadonlyArray<ServedModel>;
}

export const cached = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly id: string;
    readonly owned_by: string;
    readonly created: number | null;
    readonly display_name: string | null;
    readonly provider: string | null;
    readonly reasoning_efforts: string | null;
  }>`SELECT id, owned_by, created, display_name, provider, reasoning_efforts
    FROM models ORDER BY id`;
  const [state] = yield* sql<{
    readonly models_checked_at: number;
    readonly models_attempted_at: number;
  }>`SELECT models_checked_at, models_attempted_at FROM accounts_state WHERE id = 1`;
  const checkedAt = state?.models_checked_at ?? 0;
  return {
    checkedAt,
    attemptedAt: Math.max(state?.models_attempted_at ?? 0, checkedAt),
    models: rows.map((row): ServedModel => {
      const provider =
        row.provider === null ? null : Option.getOrNull(decodeModelChannel(row.provider));
      const reasoningEfforts =
        row.reasoning_efforts === null
          ? null
          : Option.getOrNull(decodeReasoningEfforts(row.reasoning_efforts));
      return {
        id: row.id,
        ownedBy: row.owned_by,
        created: row.created,
        ...(row.display_name === null ? {} : { displayName: row.display_name }),
        ...(provider === null ? {} : { provider }),
        ...(reasoningEfforts === null ? {} : { reasoningEfforts }),
      };
    }),
  } satisfies PoolModels;
});

/** Replaces the list, writing only when it changed. */
export const store = (models: ReadonlyArray<ServedModel>, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* cached;
    const normalized = (list: ReadonlyArray<ServedModel>) =>
      list
        .toSorted((left, right) => left.id.localeCompare(right.id))
        .map((model) => ({
          id: model.id,
          ownedBy: model.ownedBy,
          created: model.created,
          displayName: model.displayName ?? null,
          provider: model.provider ?? null,
          reasoningEfforts: model.reasoningEfforts ?? null,
        }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!Equal.equals(normalized(before.models), normalized(models))) {
          yield* sql`DELETE FROM models`;
          for (const model of models) {
            yield* sql`INSERT INTO models (id, owned_by, created, display_name, provider,
                reasoning_efforts)
              VALUES (${model.id}, ${model.ownedBy}, ${model.created}, ${model.displayName ?? null},
                ${model.provider ?? null},
                ${model.reasoningEfforts === undefined ? null : encodeReasoningEfforts(model.reasoningEfforts)})
              ON CONFLICT (id) DO NOTHING`;
          }
        }
        yield* sql`UPDATE accounts_state SET models_checked_at = ${now},
          models_attempted_at = ${now} WHERE id = 1`;
      }),
    );
  });

/** Records a read attempt without changing when the last successful read happened. */
export const markAttempted = (now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE accounts_state SET models_attempted_at = ${now} WHERE id = 1`;
  });

/** Compatibility name for callers that record a failed full-account read. */
export const markTried = markAttempted;

/** Forgets the list, as when the pool switches to another CLIProxyAPI. */
export const clear = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM models`;
  yield* sql`UPDATE accounts_state SET models_checked_at = 0, models_attempted_at = 0
    WHERE id = 1`;
});
