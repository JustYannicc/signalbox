import {
  AccountHubConnection,
  AccountPoolOverview,
  PoolLinkModels,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { modelsForSnapshot, overview, type PoolEntry, type UserPool } from "../pool/poolViews.ts";

/** No accounts, personal details, roles or routing permissions survive in this cache. */
const Snapshot = Schema.Struct({
  objectName: Schema.String,
  backing: AccountHubConnection,
  models: PoolLinkModels.fields.models,
  overview: AccountPoolOverview,
});
const SnapshotJson = Schema.fromJsonString(Snapshot);
const encode = Schema.encodeEffect(SnapshotJson);
const decode = Schema.decodeUnknownOption(SnapshotJson);

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pool_snapshots (pool_id TEXT PRIMARY KEY, value TEXT NOT NULL)`;
});

export const read = (pool: UserPool) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly value: string }>`SELECT value FROM pool_snapshots
      WHERE pool_id = ${pool.id}`;
    const held = row === undefined ? Option.none() : decode(row.value);
    if (Option.isNone(held)) return null;
    return held.value.objectName === pool.objectName &&
      Equal.equals(held.value.backing, pool.backing)
      ? held.value
      : null;
  });

export const store = (entry: PoolEntry, now: number) =>
  Effect.gen(function* () {
    if (entry.source.error) return;
    const sql = yield* SqlClient.SqlClient;
    const value = yield* encode({
      objectName: entry.pool.objectName,
      backing: entry.pool.backing,
      models: modelsForSnapshot(entry),
      overview: overview(entry.pool, entry.source, now),
    });
    yield* sql`INSERT INTO pool_snapshots (pool_id, value) VALUES (${entry.pool.id}, ${value})
      ON CONFLICT (pool_id) DO UPDATE SET value = excluded.value`;
  }).pipe(Effect.catch((error) => Effect.logWarning("pool snapshot cache write failed", error)));

export const clear = (poolId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM pool_snapshots WHERE pool_id = ${poolId}`;
  }).pipe(Effect.catch((error) => Effect.logWarning("pool snapshot cache clear failed", error)));
