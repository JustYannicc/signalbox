import type {
  ProviderDriverKind,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { POOL_INSTANCE_KINDS } from "@t3tools/contracts/accountHub";
import { advisePool, PROFILE_HOURS } from "@t3tools/shared/poolAdvice";
import {
  type AccountWindowState,
  accountWindowKey,
  HOUR_MS,
  recordRead,
  type UsageHour,
} from "@t3tools/shared/poolUsageRecording";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const KEEP_MS = 35 * 24 * HOUR_MS;
export const SAMPLE_EVERY_MS = 15 * 60_000;
// Each object holds one pool; the shared recorder also serves multi-pool servers.
const POOL_ID = "pool";

const DRIVERS: Readonly<Record<string, ProviderDriverKind | undefined>> = {
  claude: POOL_INSTANCE_KINDS.claude.driver,
  codex: POOL_INSTANCE_KINDS.codex.driver,
  xai: POOL_INSTANCE_KINDS.grok.driver,
  antigravity: POOL_INSTANCE_KINDS.antigravity.driver,
};

/** Recording includes paused accounts; advice selects the ones that take turns separately. */
export const accountsWithQuota = (
  accounts: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly disabled: boolean;
    readonly signedOut: boolean;
    readonly usageLimits: ServerProviderUsageLimits | null;
  }>,
): ReadonlyArray<UsageLimitSourceAccount> =>
  accounts.flatMap((account) => {
    const driver = DRIVERS[account.type];
    return driver === undefined || account.usageLimits === null
      ? []
      : [
          {
            id: account.name,
            driver,
            usageLimits: account.usageLimits,
            disabled: account.disabled,
            signedOut: account.signedOut,
          },
        ];
  });

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_accounts (
    account_id TEXT NOT NULL,
    window_id TEXT NOT NULL,
    used REAL NOT NULL,
    resets_at INTEGER,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, window_id)
  )`;
  yield* sql`CREATE TABLE usage_hours (
    driver TEXT NOT NULL,
    window_id TEXT NOT NULL,
    hour INTEGER NOT NULL,
    consumed REAL NOT NULL,
    PRIMARY KEY (driver, window_id, hour)
  )`;
});

export const addSampling = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_sampling (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_at INTEGER NOT NULL
  )`;
});

/** Stored independently of runtime construction so an eviction cannot postpone the next read. */
export const nextSampleAt = (now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO usage_sampling (id, next_at) VALUES (1, ${now + SAMPLE_EVERY_MS})
    ON CONFLICT (id) DO NOTHING`;
    const [row] = yield* sql<{ next_at: number }>`SELECT next_at FROM usage_sampling WHERE id = 1`;
    return row!.next_at;
  });

/** Persist before I/O so a failed or interrupted sample waits a full interval before retrying. */
export const sampledAt = (now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO usage_sampling (id, next_at) VALUES (1, ${now + SAMPLE_EVERY_MS})
    ON CONFLICT (id) DO UPDATE SET next_at = excluded.next_at`;
  });

/** Records only provider observations, not the time a cached snapshot was republished. */
export const record = (
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
  now: number,
  liveAccountIds: ReadonlyArray<string> = accounts.map((account) => account.id),
  options: { readonly fullProbe: boolean } = { fullProbe: false },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM usage_hours WHERE hour < ${Math.floor((now - KEEP_MS) / HOUR_MS)}`;
        yield* sql`DELETE FROM usage_accounts WHERE observed_at < ${now - KEEP_MS}
          OR account_id NOT IN ${sql.in(liveAccountIds)}`;
        const previous = yield* sql<AccountWindowState>`SELECT ${POOL_ID} AS "poolId",
          account_id AS "accountId", window_id AS "windowId", used,
          resets_at AS "resetsAt", observed_at AS "observedAt" FROM usage_accounts`;
        const read = recordRead({
          previous: new Map(
            previous.map((state) => [
              accountWindowKey(state.poolId, state.accountId, state.windowId),
              state,
            ]),
          ),
          pools: [{ poolId: POOL_ID, accounts }],
          now,
        });
        for (const state of read.states) {
          // Cached observations older than retention cannot create new history.
          if (state.observedAt < now - KEEP_MS) continue;
          yield* sql`INSERT INTO usage_accounts
            (account_id, window_id, used, resets_at, observed_at)
            VALUES (${state.accountId}, ${state.windowId}, ${state.used},
              ${state.resetsAt}, ${state.observedAt})
            ON CONFLICT (account_id, window_id) DO UPDATE SET
              used = excluded.used, resets_at = excluded.resets_at,
              observed_at = excluded.observed_at`;
        }
        for (const hour of read.hours) {
          if (hour.hour < Math.floor((now - KEEP_MS) / HOUR_MS)) continue;
          yield* sql`INSERT INTO usage_hours (driver, window_id, hour, consumed)
            VALUES (${hour.driver}, ${hour.windowId}, ${hour.hour}, ${hour.consumed})
            ON CONFLICT (driver, window_id, hour) DO UPDATE SET
              consumed = consumed + excluded.consumed`;
        }
        // One held account's newer observation says nothing about the rest of the pool.
        if (options.fullProbe && read.states.some((state) => state.observedAt >= now - KEEP_MS)) {
          yield* sampledAt(now);
        }
      }),
    );
  });

export const advice = (accounts: ReadonlyArray<UsageLimitSourceAccount>, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const history = yield* sql<UsageHour>`SELECT ${POOL_ID} AS "poolId", driver,
      window_id AS "windowId", hour, consumed FROM usage_hours
      WHERE hour >= ${Math.floor(now / HOUR_MS) - PROFILE_HOURS}`;
    return advisePool({ accounts, history, now });
  });

/** A different backing has different accounts and quota history. */
export const clear = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM usage_accounts`;
      yield* sql`DELETE FROM usage_hours`;
      yield* sql`DELETE FROM usage_sampling`;
    }),
  );
});
