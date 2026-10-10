/**
 * Each pool's usage history, kept in the server's database so it survives
 * restarts, and the advice built from it.
 *
 * Every read of the pools' accounts (Limits polling, or this service's own
 * quarter-hourly read when no client asks) adds the hours it covers; see
 * `poolUsageRecording.ts`. History is kept 35 days and goes with its pool.
 *
 * @module accountHub/PoolUsageHistory
 */
import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import {
  type AccountPoolAdvice,
  isAccountPoolSourceId,
  poolIdForSourceId,
} from "@t3tools/contracts/accountHub";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as AccountPools from "./AccountPools.ts";
import { advisePool, PROFILE_HOURS } from "./poolAdvice.ts";
import { takesTurns } from "./poolOverview.ts";
import {
  type AccountWindowState,
  accountWindowKey,
  HOUR_MS,
  recordRead,
  type UsageHour,
} from "./poolUsageRecording.ts";

const KEEP_MS = 35 * 24 * HOUR_MS;
/** Without a client polling Limits, pools are still read this often. */
const READ_EVERY = Duration.minutes(15);

export class PoolUsageHistory extends Context.Service<
  PoolUsageHistory,
  {
    /** Every pool's advice, now and after every read of its accounts. */
    readonly advice: Stream.Stream<ReadonlyArray<AccountPoolAdvice>>;
  }
>()("t3/accountHub/PoolUsageHistory") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageLimitSources.UsageLimitSources;
  const pools = yield* AccountPools.AccountPools;

  yield* sql`
    CREATE TABLE IF NOT EXISTS signalbox_pool_usage_hours (
      pool_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      window_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      consumed REAL NOT NULL,
      PRIMARY KEY (pool_id, driver, window_id, hour)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS signalbox_pool_usage_accounts (
      pool_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      used REAL NOT NULL,
      resets_at INTEGER,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (pool_id, account_id, window_id)
    )
  `;

  const stored = yield* sql<AccountWindowState>`
    SELECT pool_id AS "poolId", account_id AS "accountId", window_id AS "windowId", used,
      resets_at AS "resetsAt", observed_at AS "observedAt"
    FROM signalbox_pool_usage_accounts
  `;
  const states = yield* Ref.make(
    new Map(
      stored.map((state) => [
        accountWindowKey(state.poolId, state.accountId, state.windowId),
        state,
      ]),
    ),
  );
  const lastReadAt = yield* Ref.make(0);
  // Built once per read for every subscriber; none until the first build.
  const latest = yield* SubscriptionRef.make(Option.none<ReadonlyArray<AccountPoolAdvice>>());
  const lock = yield* Semaphore.make(1);

  const adviceNow = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const sources = yield* usage.current;
    const rows = yield* sql<UsageHour>`
      SELECT pool_id AS "poolId", driver, window_id AS "windowId", hour, consumed
      FROM signalbox_pool_usage_hours
      WHERE hour >= ${Math.floor(now / HOUR_MS) - PROFILE_HOURS}
    `;
    return (yield* pools.list).map((pool): AccountPoolAdvice => ({
      poolId: pool.id,
      providers: advisePool({
        accounts: (sources.find((source) => source.id === pool.sourceId)?.accounts ?? []).filter(
          takesTurns,
        ),
        history: rows.filter((row) => row.poolId === pool.id),
        now,
      }),
    }));
  });
  const rebuildAdvice = adviceNow.pipe(
    Effect.flatMap((advice) =>
      SubscriptionRef.update(latest, (current) =>
        Option.isSome(current) && Equal.equals(current.value, advice)
          ? current
          : Option.some(advice),
      ),
    ),
    Effect.ignoreCause({ log: true }),
  );

  const record = (sources: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const read = recordRead({
        previous: yield* Ref.get(states),
        // A hub that failed to answer lists no accounts; that is no read at all.
        pools: sources.flatMap((source) => {
          const poolId = poolIdForSourceId(source.id);
          return poolId && source.error === undefined
            ? [{ poolId, accounts: source.accounts }]
            : [];
        }),
        now,
      });
      // No pool answered: nothing to record, and the advice stands.
      if (read.states.length === 0) return;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const state of read.states) {
            yield* sql`
              INSERT INTO signalbox_pool_usage_accounts
                (pool_id, account_id, window_id, used, resets_at, observed_at)
              VALUES (${state.poolId}, ${state.accountId}, ${state.windowId}, ${state.used},
                ${state.resetsAt}, ${state.observedAt})
              ON CONFLICT (pool_id, account_id, window_id) DO UPDATE SET
                used = excluded.used, resets_at = excluded.resets_at, observed_at = excluded.observed_at
            `;
          }
          for (const hour of read.hours) {
            yield* sql`
              INSERT INTO signalbox_pool_usage_hours (pool_id, driver, window_id, hour, consumed)
              VALUES (${hour.poolId}, ${hour.driver}, ${hour.windowId}, ${hour.hour}, ${hour.consumed})
              ON CONFLICT (pool_id, driver, window_id, hour) DO UPDATE SET
                consumed = consumed + excluded.consumed
            `;
          }
        }),
      );
      yield* Ref.update(states, (current) => {
        const next = new Map(current);
        for (const state of read.states) {
          next.set(accountWindowKey(state.poolId, state.accountId, state.windowId), state);
        }
        return next;
      });
      yield* Ref.set(lastReadAt, now);
      yield* rebuildAdvice;
    }).pipe(lock.withPermits(1), Effect.ignoreCause({ log: true }));

  /** Drops history past {@link KEEP_MS} and history of pools that are gone. */
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const poolIds = (yield* pools.list).map((pool) => pool.id);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM signalbox_pool_usage_hours
          WHERE hour < ${Math.floor((now - KEEP_MS) / HOUR_MS)}
            OR pool_id NOT IN ${sql.in(poolIds)}
        `;
        yield* sql`
          DELETE FROM signalbox_pool_usage_accounts
          WHERE observed_at < ${now - KEEP_MS}
            OR pool_id NOT IN ${sql.in(poolIds)}
        `;
      }),
    );
    yield* Ref.update(
      states,
      (current) =>
        new Map(
          [...current].filter(
            ([, state]) => state.observedAt >= now - KEEP_MS && poolIds.includes(state.poolId),
          ),
        ),
    );
  }).pipe(lock.withPermits(1), Effect.ignoreCause({ log: true }));

  yield* rebuildAdvice.pipe(Effect.forkScoped);
  yield* usage.streamChanges.pipe(Stream.runForEach(record), Effect.forkScoped);
  yield* pools.listChanges.pipe(
    Stream.runForEach(() => prune),
    Effect.forkScoped,
  );
  yield* Effect.forever(Effect.sleep(Duration.hours(1)).pipe(Effect.andThen(prune))).pipe(
    Effect.forkScoped,
  );
  // Limits only polls while someone has it open; history needs reads either way.
  yield* Effect.forever(
    Effect.sleep(READ_EVERY).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const pooled = (yield* usage.current).some(
            (source) => isAccountPoolSourceId(source.id) && source.accounts.length > 0,
          );
          if (pooled && now - (yield* Ref.get(lastReadAt)) >= Duration.toMillis(READ_EVERY)) {
            yield* usage.refresh;
          }
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return {
    advice: SubscriptionRef.changes(latest).pipe(
      Stream.filter(Option.isSome),
      Stream.map((advice) => advice.value),
    ),
  } satisfies PoolUsageHistory["Service"];
});

export const layer = Layer.effect(PoolUsageHistory, make);
