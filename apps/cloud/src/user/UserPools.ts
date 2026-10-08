import {
  type AccountHubConnection,
  type AccountPool,
  AccountHubRpcError,
  type AccountPoolCreateInput,
  type AccountPoolDeleteInput,
  type AccountPoolRenameInput,
  type AccountPoolSetBackingInput,
  PERSONAL_POOL_ID,
  poolIdForSourceId,
} from "@t3tools/contracts/accountHub";
import {
  UsageLimitSourceError,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceUpdateAccountInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { PoolActor } from "../pool/PoolEngine.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { type UserPool, accountPool, poolOfInstance, usageSource } from "../pool/poolViews.ts";

/**
 * A user's pools: a plain list in their own object of every pool they own,
 * with what the sidebar, the picker, Settings → Pools and Limits need to
 * render it. Each pool itself lives in its own object (`pool/PoolObject.ts`),
 * which is the authority on its name, accounts and grants; this list is the
 * user's index of them. Personal is created on first use.
 *
 * Pools shared with the user, and the defaults that pick a pool for a new
 * thread, come with the cross-context index (#152).
 */

export interface PoolsState {
  readonly pools: ReadonlyArray<UserPool>;
  /** One per pool, in the same order. */
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
}

export class UserPools extends Context.Service<
  UserPools,
  {
    readonly state: (actor: PoolActor) => Effect.Effect<PoolsState, AccountHubRpcError>;
    /** The pools now, then again after every change to them or their accounts. */
    readonly changes: (actor: PoolActor) => Stream.Stream<PoolsState, AccountHubRpcError>;
    readonly create: (
      actor: PoolActor,
      input: AccountPoolCreateInput,
    ) => Effect.Effect<AccountPool, AccountHubRpcError>;
    readonly rename: (
      actor: PoolActor,
      input: AccountPoolRenameInput,
    ) => Effect.Effect<AccountPool, AccountHubRpcError>;
    readonly delete: (
      actor: PoolActor,
      input: AccountPoolDeleteInput,
    ) => Effect.Effect<void, AccountHubRpcError>;
    readonly setBacking: (
      actor: PoolActor,
      input: AccountPoolSetBackingInput,
    ) => Effect.Effect<AccountPool, AccountHubRpcError>;
    readonly updateAccount: (
      actor: PoolActor,
      input: UsageLimitSourceUpdateAccountInput,
    ) => Effect.Effect<void, UsageLimitSourceError>;
    /** The pool behind one of its provider instances. */
    readonly poolOfInstance: (
      actor: PoolActor,
      instanceId: string,
    ) => Effect.Effect<ReturnType<typeof poolOfInstance>, AccountHubRpcError>;
    /** Tells every subscriber to read the pools again, e.g. after a sign-in. */
    readonly refresh: Effect.Effect<void>;
  }
>()("@signalbox/cloud/user/UserPools") {}

/** Part of `UserStore`'s pools migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE pools (
    id TEXT PRIMARY KEY,
    object_name TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    personal INTEGER NOT NULL,
    backing_url TEXT,
    created_at INTEGER NOT NULL
  )`;
});

interface PoolRow {
  readonly id: string;
  readonly object_name: string;
  readonly name: string;
  readonly personal: number;
  readonly backing_url: string | null;
}

const fromRow = (row: PoolRow): UserPool => ({
  id: row.id,
  objectName: row.object_name,
  name: row.name,
  personal: row.personal === 1,
  backing:
    row.backing_url === null ? { mode: "managed" } : { mode: "external", url: row.backing_url },
});

const backingUrl = (backing: AccountHubConnection) =>
  backing.mode === "external" ? backing.url : null;

const PERSONAL_POOL_NAME = "Personal";

const storageFailed = (cause: SqlError) =>
  Effect.logError("cloud pools storage failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new AccountHubRpcError({ detail: "Could not load or update pools." })),
    ),
  );

/** A pool object's refusal as the user sees it; anything else is logged. */
const poolFailure = (
  error:
    | PoolDirectory.PoolObjectError
    | { readonly _tag: "PoolRejectedError"; readonly reason: string },
) =>
  error._tag === "PoolRejectedError"
    ? Effect.fail(new AccountHubRpcError({ detail: error.reason }))
    : Effect.logError("pool object call failed", { cause: error }).pipe(
        Effect.andThen(
          Effect.fail(
            new AccountHubRpcError({ detail: "The pool is unavailable right now. Try again." }),
          ),
        ),
      );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* PoolDirectory.PoolDirectory;
  const crypto = yield* Crypto.Crypto;
  /** Pool ids: 8 lowercase hex characters, like a self-hosted server's. */
  const newPoolId = Effect.map(Effect.orDie(crypto.randomUUIDv4), (uuid) =>
    uuid.replaceAll("-", "").slice(0, 8),
  );
  // Sliding at one: a subscriber that falls behind needs only the latest state.
  const changed = yield* PubSub.sliding<void>(1);
  const publish = PubSub.publish(changed, undefined).pipe(Effect.asVoid);

  const rows = sql<PoolRow>`SELECT id, object_name, name, personal, backing_url FROM pools
    ORDER BY personal DESC, created_at, id`.pipe(Effect.map((all) => all.map(fromRow)));

  const insert = (pool: UserPool) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO pools (id, object_name, name, personal, backing_url, created_at)
        VALUES (${pool.id}, ${pool.objectName}, ${pool.name}, ${pool.personal ? 1 : 0},
          ${backingUrl(pool.backing)}, ${now})
        ON CONFLICT (id) DO NOTHING`;
    });

  /** Every user has Personal; its object is named by the user, so creating it twice is harmless. */
  const pools = (actor: PoolActor) =>
    Effect.gen(function* () {
      const current = yield* rows;
      if (current.some((pool) => pool.personal)) return current;
      const objectName = PoolDirectory.poolObjectName(actor.userId, PERSONAL_POOL_ID);
      const info = yield* directory
        .forPool(objectName)
        .create(actor, { name: PERSONAL_POOL_NAME, personal: true });
      yield* insert({
        id: PERSONAL_POOL_ID,
        objectName,
        name: info.name,
        personal: true,
        backing: info.backing,
      });
      return yield* rows;
    }).pipe(
      Effect.catchTags({
        SqlError: storageFailed,
        PoolObjectError: poolFailure,
        PoolRejectedError: poolFailure,
      }),
    );

  const requirePool = (actor: PoolActor, poolId: string) =>
    Effect.flatMap(pools(actor), (all) => {
      const pool = all.find((candidate) => candidate.id === poolId);
      return pool
        ? Effect.succeed(pool)
        : Effect.fail(new AccountHubRpcError({ detail: "That pool no longer exists." }));
    });

  const state: UserPools["Service"]["state"] = (actor) =>
    Effect.gen(function* () {
      const all = yield* pools(actor);
      const now = yield* Clock.currentTimeMillis;
      const sources = yield* Effect.forEach(
        all,
        (pool) =>
          directory
            .forPool(pool.objectName)
            .accounts(actor)
            .pipe(
              Effect.catchTags({
                PoolRejectedError: (error) => Effect.succeed({ error: error.reason }),
                PoolObjectError: (error) =>
                  Effect.logError("pool accounts unavailable", { cause: error }).pipe(
                    Effect.as({ error: "The pool is unavailable right now." }),
                  ),
              }),
              Effect.map((accounts) => usageSource({ pool, accounts }, now)),
            ),
        { concurrency: "unbounded" },
      );
      return { pools: all, sources };
    });

  const changes: UserPools["Service"]["changes"] = (actor) =>
    Stream.unwrap(
      // Subscribe before the first read, so no change slips between them.
      Effect.map(PubSub.subscribe(changed), (subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.prepend([undefined]),
          Stream.mapEffect(() => state(actor)),
        ),
      ),
    );

  const create: UserPools["Service"]["create"] = (actor, input) =>
    Effect.gen(function* () {
      yield* pools(actor);
      const id = yield* newPoolId;
      const objectName = PoolDirectory.poolObjectName(actor.userId, id);
      const name = input.name.trim();
      const info = yield* directory
        .forPool(objectName)
        .create(actor, { name, personal: false })
        .pipe(Effect.catchTags({ PoolRejectedError: poolFailure, PoolObjectError: poolFailure }));
      const pool: UserPool = {
        id,
        objectName,
        name: info.name,
        personal: false,
        backing: info.backing,
      };
      yield* insert(pool).pipe(Effect.catchTags({ SqlError: storageFailed }));
      yield* publish;
      return accountPool(pool);
    });

  const rename: UserPools["Service"]["rename"] = (actor, input) =>
    Effect.gen(function* () {
      const pool = yield* requirePool(actor, input.poolId);
      const info = yield* directory
        .forPool(pool.objectName)
        .rename(actor, input.name.trim())
        .pipe(Effect.catchTags({ PoolRejectedError: poolFailure, PoolObjectError: poolFailure }));
      yield* sql`UPDATE pools SET name = ${info.name} WHERE id = ${pool.id}`.pipe(
        Effect.catchTags({ SqlError: storageFailed }),
      );
      yield* publish;
      return accountPool({ ...pool, name: info.name });
    });

  const remove: UserPools["Service"]["delete"] = (actor, input) =>
    Effect.gen(function* () {
      const pool = yield* requirePool(actor, input.poolId);
      if (pool.personal) {
        return yield* new AccountHubRpcError({ detail: "Your personal pool can't be deleted." });
      }
      // The pool first: a row left behind by a failure here can be deleted again.
      yield* directory
        .forPool(pool.objectName)
        .delete(actor)
        .pipe(Effect.catchTags({ PoolRejectedError: poolFailure, PoolObjectError: poolFailure }));
      yield* sql`DELETE FROM pools WHERE id = ${pool.id}`.pipe(
        Effect.catchTags({ SqlError: storageFailed }),
      );
      yield* publish;
    });

  const setBacking: UserPools["Service"]["setBacking"] = (actor, input) =>
    Effect.gen(function* () {
      const pool = yield* requirePool(actor, input.poolId);
      const info = yield* directory
        .forPool(pool.objectName)
        .setBacking(actor, input.backing)
        .pipe(Effect.catchTags({ PoolRejectedError: poolFailure, PoolObjectError: poolFailure }));
      yield* sql`UPDATE pools SET backing_url = ${backingUrl(info.backing)} WHERE id = ${pool.id}`.pipe(
        Effect.catchTags({ SqlError: storageFailed }),
      );
      yield* publish;
      return accountPool({ ...pool, backing: info.backing });
    });

  const updateAccount: UserPools["Service"]["updateAccount"] = (actor, input) =>
    Effect.gen(function* () {
      const poolId = poolIdForSourceId(input.sourceId);
      if (poolId === null) {
        return yield* new AccountHubRpcError({ detail: "That source is not a pool." });
      }
      const pool = yield* requirePool(actor, poolId);
      yield* directory
        .forPool(pool.objectName)
        .updateAccount(actor, input.accountId, input.action)
        .pipe(Effect.catchTags({ PoolRejectedError: poolFailure, PoolObjectError: poolFailure }));
      yield* publish;
    }).pipe(Effect.mapError((error) => new UsageLimitSourceError({ detail: error.detail })));

  return UserPools.of({
    state,
    changes,
    create,
    rename,
    delete: remove,
    setBacking,
    updateAccount,
    poolOfInstance: (actor, instanceId) =>
      Effect.map(pools(actor), (all) => poolOfInstance(all, instanceId)),
    refresh: publish,
  });
});

export const layer = Layer.effect(UserPools, make);
