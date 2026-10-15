import {
  type AccountHubConnection,
  type AccountPool,
  AccountHubRpcError,
  type AccountPoolCreateInput,
  type AccountPoolDeleteInput,
  type AccountPoolReceiveInput,
  type AccountPoolReceiveResult,
  type AccountPoolRenameInput,
  type AccountPoolSetBackingInput,
  PERSONAL_POOL_ID,
  poolIdForSourceId,
} from "@t3tools/contracts/accountHub";
import { UsageLimitSourceError, type UsageLimitSourceUpdateAccountInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { PoolActor, PoolRejectedError } from "../pool/PoolEngine.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import { encodeLinkToken } from "../pool/poolLink.ts";
import * as UserFolders from "./UserFolders.ts";
import {
  type PoolEntry,
  type UserPool,
  accountPool,
  poolOfInstance,
  usageSource,
} from "../pool/poolViews.ts";

/**
 * A user's pools: a plain list in their own object of every pool they own,
 * with what the picker, Settings → Pools and Limits need to render it. Each
 * pool itself lives in its own object (`pool/PoolObject.ts`), which is the
 * authority on its name, accounts and grants; this list is the user's index
 * of them. Personal is created on first use.
 *
 * The pools with their accounts are read once per change and shared by every
 * subscription on every connection.
 *
 * Which pool a thread runs on is placed in the user's tree (`UserFolders`,
 * `poolChain.ts`); deleting a pool takes it off every level there.
 */

/** Every pool, in order, with its accounts. */
export type PoolsState = ReadonlyArray<PoolEntry>;

export class UserPools extends Context.Service<
  UserPools,
  {
    /** The pools now, read once and then shared until something changes. */
    readonly state: (actor: PoolActor) => Effect.Effect<PoolsState, AccountHubRpcError>;
    /** The pools now, then again after every change to them or their accounts. */
    readonly changes: (actor: PoolActor) => Stream.Stream<PoolsState, AccountHubRpcError>;
    /** Reads every pool's accounts again, e.g. after a sign-in, and tells every subscriber. */
    readonly refresh: (actor: PoolActor) => Effect.Effect<PoolsState, AccountHubRpcError>;
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
    /**
     * A pool ready to take a pool another server moves here, and the link that
     * server sends its accounts over and keeps. A personal pool joins Personal.
     */
    readonly receive: (
      actor: PoolActor,
      input: AccountPoolReceiveInput,
    ) => Effect.Effect<AccountPoolReceiveResult, AccountHubRpcError>;
    /** The user's own pools, without reading their accounts. */
    readonly list: (actor: PoolActor) => Effect.Effect<ReadonlyArray<UserPool>, AccountHubRpcError>;
    /**
     * Backs the pool with this id (Personal for a personal one) by a pool link
     * elsewhere, creating it under that id and name when it's missing. How a
     * preview's pools route through production's (`previewSetup/`). Doesn't
     * refresh; the caller does once it's linked everything.
     */
    readonly link: (
      actor: PoolActor,
      pool: { readonly id: string; readonly name: string; readonly personal: boolean },
      backing: { readonly url: string; readonly key: string },
    ) => Effect.Effect<void, AccountHubRpcError>;
    /** The pool behind one of its provider instances. */
    readonly poolOfInstance: (
      actor: PoolActor,
      instanceId: string,
    ) => Effect.Effect<ReturnType<typeof poolOfInstance>, AccountHubRpcError>;
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

/** A pool object's refusal or outage, as the user sees it. */
const poolFailure = (error: PoolDirectory.PoolObjectError | PoolRejectedError) =>
  Effect.flatMap(PoolDirectory.poolErrorMessage(error), (detail) =>
    Effect.fail(new AccountHubRpcError({ detail })),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* PoolDirectory.PoolDirectory;
  const folders = yield* UserFolders.UserFolders;
  const crypto = yield* Crypto.Crypto;
  /** Pool ids: 8 lowercase hex characters, like a self-hosted server's. */
  const newPoolId = Effect.map(Effect.orDie(crypto.randomUUIDv4()), (uuid) =>
    uuid.replaceAll("-", "").slice(0, 8),
  );
  // None until the first read; reads take turns so a change is read once.
  const current = yield* SubscriptionRef.make(Option.none<PoolsState>());
  const reading = yield* Semaphore.make(1);

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
      const listed = yield* rows;
      if (listed.some((pool) => pool.personal)) return listed;
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

  /** Reads every pool's accounts and shares the result with every subscriber. */
  const refresh: UserPools["Service"]["refresh"] = (actor) =>
    reading.withPermits(1)(
      Effect.gen(function* () {
        const all = yield* pools(actor);
        const now = yield* Clock.currentTimeMillis;
        const state = yield* Effect.forEach(
          all,
          (pool) =>
            directory
              .forPool(pool.objectName)
              .accounts(actor)
              .pipe(
                Effect.catchTags({
                  PoolRejectedError: (error) => Effect.succeed({ error: error.reason }),
                  PoolObjectError: (error) =>
                    Effect.map(PoolDirectory.poolErrorMessage(error), (message) => ({
                      error: message,
                    })),
                }),
                Effect.map((accounts): PoolEntry => ({
                  pool,
                  source: usageSource({ pool, accounts }, now),
                  models: "models" in accounts ? accounts.models : [],
                  role: "role" in accounts ? accounts.role : null,
                })),
              ),
          { concurrency: "unbounded" },
        );
        yield* SubscriptionRef.set(current, Option.some(state));
        return state;
      }),
    );

  const state: UserPools["Service"]["state"] = (actor) =>
    Effect.flatMap(SubscriptionRef.get(current), (known) =>
      Option.isSome(known) ? Effect.succeed(known.value) : refresh(actor),
    );

  const changes: UserPools["Service"]["changes"] = (actor) =>
    Stream.unwrap(
      Effect.as(
        state(actor),
        SubscriptionRef.changes(current).pipe(
          Stream.filter(Option.isSome),
          Stream.map((known) => known.value),
        ),
      ),
    );

  /** A pool object call, failing the way pool RPCs fail. */
  const call = <A>(effect: Effect.Effect<A, PoolDirectory.PoolObjectError | PoolRejectedError>) =>
    effect.pipe(Effect.catchTags({ PoolRejectedError: poolFailure, PoolObjectError: poolFailure }));

  const createPool = (actor: PoolActor, name: string, poolId?: string) =>
    Effect.gen(function* () {
      const id = poolId ?? (yield* newPoolId);
      const objectName = PoolDirectory.poolObjectName(actor.userId, id);
      const info = yield* call(
        directory.forPool(objectName).create(actor, { name: name.trim(), personal: false }),
      );
      const pool: UserPool = {
        id,
        objectName,
        name: info.name,
        personal: false,
        backing: info.backing,
      };
      yield* insert(pool).pipe(Effect.catchTags({ SqlError: storageFailed }));
      return pool;
    });

  const create: UserPools["Service"]["create"] = (actor, input) =>
    Effect.gen(function* () {
      yield* pools(actor);
      const pool = yield* createPool(actor, input.name);
      yield* refresh(actor);
      return accountPool(pool);
    });

  const rename: UserPools["Service"]["rename"] = (actor, input) =>
    Effect.gen(function* () {
      const pool = yield* requirePool(actor, input.poolId);
      const info = yield* call(directory.forPool(pool.objectName).rename(actor, input.name.trim()));
      yield* sql`UPDATE pools SET name = ${info.name} WHERE id = ${pool.id}`.pipe(
        Effect.catchTags({ SqlError: storageFailed }),
      );
      yield* refresh(actor);
      return accountPool({ ...pool, name: info.name });
    });

  const remove: UserPools["Service"]["delete"] = (actor, input) =>
    Effect.gen(function* () {
      const pool = yield* requirePool(actor, input.poolId);
      if (pool.personal) {
        return yield* new AccountHubRpcError({ detail: "Your personal pool can't be deleted." });
      }
      // The pool first; deleting one that is already gone succeeds, so a row
      // left behind by a failure here can be deleted again.
      yield* call(directory.forPool(pool.objectName).delete(actor));
      yield* sql`DELETE FROM pools WHERE id = ${pool.id}`.pipe(
        Effect.andThen(folders.forgetPool(pool.id)),
        Effect.catchTags({ SqlError: storageFailed }),
      );
      yield* refresh(actor);
    });

  /** Changes the pool's backing in its object, then in this list. */
  const applyBacking = (
    actor: PoolActor,
    pool: UserPool,
    backing: AccountPoolSetBackingInput["backing"],
  ) =>
    Effect.gen(function* () {
      const info = yield* call(directory.forPool(pool.objectName).setBacking(actor, backing));
      yield* sql`UPDATE pools SET backing_url = ${backingUrl(info.backing)} WHERE id = ${pool.id}`.pipe(
        Effect.catchTags({ SqlError: storageFailed }),
      );
      return info;
    });

  const setBacking: UserPools["Service"]["setBacking"] = (actor, input) =>
    Effect.gen(function* () {
      const pool = yield* requirePool(actor, input.poolId);
      const info = yield* applyBacking(actor, pool, input.backing);
      yield* refresh(actor);
      return accountPool({ ...pool, backing: info.backing });
    });

  const receive: UserPools["Service"]["receive"] = (actor, input) =>
    Effect.gen(function* () {
      const all = yield* pools(actor);
      const personal = input.personal ? all.find((pool) => pool.personal) : undefined;
      const pool = personal ?? (yield* createPool(actor, input.name));
      const secret = yield* call(directory.forPool(pool.objectName).openLink(actor)).pipe(
        // A pool made only to take this move goes again when it can't.
        Effect.onError(() =>
          personal === undefined
            ? remove(actor, { poolId: pool.id }).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      // Not refreshed here: the pool lists once the client refreshes after the move.
      return {
        poolId: pool.id,
        personal: pool.personal,
        token: encodeLinkToken(pool.objectName, secret),
      };
    });

  const link: UserPools["Service"]["link"] = (actor, input, backing) =>
    Effect.gen(function* () {
      const all = yield* pools(actor);
      const existing = all.find((pool) => (input.personal ? pool.personal : pool.id === input.id));
      const pool = existing ?? (yield* createPool(actor, input.name, input.id));
      yield* applyBacking(actor, pool, {
        mode: "external",
        url: backing.url,
        managementKey: backing.key,
        clientKey: backing.key,
      });
    });

  const updateAccount: UserPools["Service"]["updateAccount"] = (actor, input) =>
    Effect.gen(function* () {
      const poolId = poolIdForSourceId(input.sourceId);
      if (poolId === null) {
        return yield* new AccountHubRpcError({ detail: "That source is not a pool." });
      }
      const pool = yield* requirePool(actor, poolId);
      yield* call(
        directory.forPool(pool.objectName).updateAccount(actor, input.accountId, input.action),
      );
      yield* refresh(actor);
    }).pipe(Effect.mapError((error) => new UsageLimitSourceError({ detail: error.detail })));

  return UserPools.of({
    state,
    changes,
    refresh,
    create,
    rename,
    delete: remove,
    setBacking,
    updateAccount,
    receive,
    list: pools,
    link,
    poolOfInstance: (actor, instanceId) =>
      Effect.map(pools(actor), (all) => poolOfInstance(all, instanceId)),
  });
});

export const layer = Layer.effect(UserPools, make);
