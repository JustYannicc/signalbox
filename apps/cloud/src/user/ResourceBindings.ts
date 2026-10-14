import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { ProjectId } from "@t3tools/contracts";
import type { PoolLevel } from "@t3tools/contracts/sections";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * What sits at each level of the user's tree: a resource (only pools so far),
 * placed at the top level, a section or a project, with its reach. `here`
 * serves only its level; `below` serves its level and everything under it.
 * What a thread runs on follows from these (`poolChain.ts`). Storage only:
 * `UserSections` makes every change and tells subscribers.
 */

export type Reach = "here" | "below";

export interface PoolBinding {
  readonly level: PoolLevel;
  readonly poolId: string;
  readonly reach: Reach;
}

export class ResourceBindings extends Context.Service<
  ResourceBindings,
  {
    /** Every pool binding whose pool the user still has, oldest first per level. */
    readonly pools: Effect.Effect<ReadonlyArray<PoolBinding>, SqlError>;
    /**
     * Places `poolId` at `level` with reach `below`, replacing the pool there;
     * null leaves the level to inherit from above. `known` is false when the
     * user has no such pool. Callers run it in their transaction.
     */
    readonly setPool: (
      level: PoolLevel,
      poolId: string | null,
    ) => Effect.Effect<{ readonly known: boolean; readonly changed: boolean }, SqlError>;
    /** Takes a deleted pool off every level. True when it was placed anywhere. */
    readonly forgetPool: (poolId: string) => Effect.Effect<boolean, SqlError>;
    /** Every row as stored: what a preview takes along (`previewSetup/`). */
    readonly rows: Effect.Effect<ReadonlyArray<BindingRow>, SqlError>;
    /** Adds bindings another of this user's clouds holds, at levels that have none here. */
    readonly adopt: (rows: ReadonlyArray<BindingRow>) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/user/ResourceBindings") {}

/**
 * `UserStore`'s `0012` migration. The top level gets the Personal pool with
 * reach `below`, so every thread resolves to at least that.
 */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `level_id` is empty for the top level.
  yield* sql`CREATE TABLE resource_bindings (
    level_kind TEXT NOT NULL,
    level_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    reach TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (level_kind, level_id, kind, resource_id)
  )`;
  yield* sql`INSERT INTO resource_bindings (level_kind, level_id, kind, resource_id, reach, created_at)
    VALUES ('top', '', 'pool', ${PERSONAL_POOL_ID}, 'below', 0)`;
});

export const BindingRow = Schema.Struct({
  level_kind: Schema.Literals(["top", "section", "project"]),
  level_id: Schema.String,
  kind: Schema.String,
  resource_id: Schema.String,
  reach: Schema.Literals(["here", "below"]),
  created_at: Schema.Number,
});
export type BindingRow = typeof BindingRow.Type;
const decodeRows = Schema.decodeUnknownSync(Schema.Array(BindingRow));

const levelKey = (level: PoolLevel) => {
  switch (level._tag) {
    case "top":
      return { kind: "top", id: "" } as const;
    case "section":
      return { kind: "section", id: level.sectionId } as const;
    case "project":
      return { kind: "project", id: level.projectId } as const;
  }
};

const levelOf = (row: BindingRow): PoolLevel => {
  switch (row.level_kind) {
    case "top":
      return { _tag: "top" };
    case "section":
      return { _tag: "section", sectionId: row.level_id };
    case "project":
      return { _tag: "project", projectId: ProjectId.make(row.level_id) };
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Personal is created on first use (`UserPools`), so it counts before it's listed.
  const isKnownPool = (poolId: string) =>
    poolId === PERSONAL_POOL_ID
      ? Effect.succeed(true)
      : Effect.map(sql`SELECT 1 FROM pools WHERE id = ${poolId}`, (rows) => rows.length > 0);

  const pools: ResourceBindings["Service"]["pools"] = Effect.map(
    sql`SELECT level_kind, level_id, kind, resource_id, reach, created_at FROM resource_bindings
      WHERE kind = 'pool'
        AND (resource_id = ${PERSONAL_POOL_ID} OR resource_id IN (SELECT id FROM pools))
      ORDER BY created_at, resource_id`,
    (rows) =>
      decodeRows(rows).map((row) => ({
        level: levelOf(row),
        poolId: row.resource_id,
        reach: row.reach,
      })),
  );

  const setPool: ResourceBindings["Service"]["setPool"] = (level, poolId) =>
    Effect.gen(function* () {
      if (poolId !== null && !(yield* isKnownPool(poolId))) {
        return { known: false, changed: false };
      }
      const { kind, id } = levelKey(level);
      const current = decodeRows(
        yield* sql`SELECT level_kind, level_id, kind, resource_id, reach, created_at
              FROM resource_bindings WHERE level_kind = ${kind} AND level_id = ${id} AND kind = 'pool'`,
      );
      if (
        poolId === null
          ? current.length === 0
          : current.length === 1 && current[0]?.resource_id === poolId
      ) {
        return { known: true, changed: false };
      }
      yield* sql`DELETE FROM resource_bindings
            WHERE level_kind = ${kind} AND level_id = ${id} AND kind = 'pool'`;
      if (poolId !== null) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO resource_bindings
                (level_kind, level_id, kind, resource_id, reach, created_at)
              VALUES (${kind}, ${id}, 'pool', ${poolId}, 'below', ${now})`;
      }
      return { known: true, changed: true };
    });

  const forgetPool: ResourceBindings["Service"]["forgetPool"] = (poolId) =>
    Effect.map(
      sql`DELETE FROM resource_bindings
        WHERE kind = 'pool' AND resource_id = ${poolId} RETURNING resource_id`,
      (removed) => removed.length > 0,
    );

  const rows: ResourceBindings["Service"]["rows"] = Effect.map(
    sql`SELECT level_kind, level_id, kind, resource_id, reach, created_at FROM resource_bindings`,
    decodeRows,
  );

  const adopt: ResourceBindings["Service"]["adopt"] = (input) =>
    Effect.forEach(
      input,
      (row) =>
        sql`INSERT INTO resource_bindings
                (level_kind, level_id, kind, resource_id, reach, created_at)
              SELECT ${row.level_kind}, ${row.level_id}, ${row.kind}, ${row.resource_id},
                ${row.reach}, ${row.created_at}
              WHERE NOT EXISTS (SELECT 1 FROM resource_bindings
                WHERE level_kind = ${row.level_kind} AND level_id = ${row.level_id}
                  AND kind = ${row.kind})`,
      { discard: true },
    );

  return ResourceBindings.of({
    pools,
    setPool,
    forgetPool,
    rows,
    adopt,
  });
});

export const layer = Layer.effect(ResourceBindings, make);
