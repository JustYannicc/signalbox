import {
  type AccountHubConnection,
  type AccountPool,
  type AccountPoolOverview,
  type AccountPoolProvider,
  POOL_INSTANCE_KINDS,
  poolInstanceEntry,
  poolSourceId,
} from "@t3tools/contracts/accountHub";
import {
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { CLOUD_POOL_KINDS, poolServerProvider } from "../thread/providerCatalog.ts";
import type { PoolAccounts } from "./PoolEngine.ts";

/**
 * A user's pools as clients see them: the pool list, one usage source per
 * pool for Usage → Limits, member-safe overviews for the picker and agents,
 * and each pool's provider instances (`claude_hub_<poolId>`, …), which is
 * what a thread picks to run on a pool.
 */

export interface UserPool {
  readonly id: string;
  readonly objectName: string;
  readonly name: string;
  readonly personal: boolean;
  readonly backing: AccountHubConnection;
}

/** A pool with what its object last said about its accounts. */
export interface PoolWithAccounts {
  readonly pool: UserPool;
  readonly accounts: PoolAccounts | { readonly error: string };
}

export const accountPool = (pool: UserPool): AccountPool => ({
  id: pool.id,
  name: pool.name,
  sourceId: poolSourceId(pool.id),
  backing: pool.backing,
  personal: pool.personal,
});

/** CLIProxyAPI's credential types, as the drivers clients draw them with. */
const DRIVER_BY_ACCOUNT_TYPE: Record<string, ProviderDriverKind> = {
  claude: POOL_INSTANCE_KINDS.claude.driver,
  codex: POOL_INSTANCE_KINDS.codex.driver,
  xai: POOL_INSTANCE_KINDS.grok.driver,
  antigravity: POOL_INSTANCE_KINDS.antigravity.driver,
};

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** Limits per account are not read in the cloud yet; the account list is. */
const usageNotRead = (checkedAt: string): UsageLimitSourceAccount["usageLimits"] => ({
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported", message: "Signalbox Cloud doesn't read limits yet." },
});

/** The pool's accounts as one usage limit source, grouped under the pool in Limits. */
export const usageSource = (entry: PoolWithAccounts, now: number): UsageLimitSourceSnapshot => {
  const base = {
    id: poolSourceId(entry.pool.id),
    kind: "cliproxy",
    label: entry.pool.name,
  } as const;
  if (!("accounts" in entry.accounts)) {
    return { ...base, checkedAt: iso(now), accounts: [], error: entry.accounts.error };
  }
  const { accounts, checkedAt, error } = entry.accounts;
  const at = iso(checkedAt > 0 ? checkedAt : now);
  return {
    ...base,
    checkedAt: at,
    accounts: accounts.flatMap((account) => {
      const driver = DRIVER_BY_ACCOUNT_TYPE[account.type];
      if (driver === undefined) return [];
      return [
        {
          id: account.name,
          driver,
          ...(account.email ? { email: account.email } : {}),
          usageLimits: usageNotRead(at),
          ...(account.disabled ? { disabled: true } : {}),
          ...(account.signedOut ? { signedOut: true } : {}),
        },
      ];
    }),
    ...(error ? { error } : {}),
  };
};

/** Whether `source` holds an account of `driver` that can take turns. */
const canRun = (source: UsageLimitSourceSnapshot, driver: ProviderDriverKind) =>
  source.accounts.some(
    (account) => account.driver === driver && !account.disabled && !account.signedOut,
  );

const instanceOf = (kind: (typeof CLOUD_POOL_KINDS)[number], pool: UserPool) =>
  poolInstanceEntry(kind, { id: pool.id, name: pool.personal ? undefined : pool.name });

/**
 * What any member may see: per provider, whether it can run now. No account
 * count, emails or plans, and no usage windows until the cloud reads limits.
 */
export const overview = (
  pool: UserPool,
  source: UsageLimitSourceSnapshot,
): AccountPoolOverview => ({
  id: pool.id,
  name: pool.name,
  providers: CLOUD_POOL_KINDS.map((kind): AccountPoolProvider => {
    const [providerInstanceId] = instanceOf(kind, pool);
    const { driver, displayName } = POOL_INSTANCE_KINDS[kind];
    return {
      providerInstanceId,
      driver,
      displayName,
      available: canRun(source, driver),
      usage: [],
    };
  }),
});

/** Each pool's provider instances, for `ServerConfig.providers`. */
export const poolProviders = (
  pools: ReadonlyArray<{ readonly pool: UserPool; readonly source: UsageLimitSourceSnapshot }>,
  checkedAt: string,
): ReadonlyArray<ServerProvider> =>
  pools.flatMap(({ pool, source }) =>
    CLOUD_POOL_KINDS.map((kind) => {
      const [instanceId, config] = instanceOf(kind, pool);
      return poolServerProvider({
        kind,
        instanceId,
        displayName: config.displayName ?? POOL_INSTANCE_KINDS[kind].displayName,
        signedIn: canRun(source, POOL_INSTANCE_KINDS[kind].driver),
        checkedAt,
      });
    }),
  );

/** Settings list each instance with its pool, which is how clients group instances by pool. */
export const poolProviderInstances = (
  pools: ReadonlyArray<UserPool>,
): Record<ProviderInstanceId, ProviderInstanceConfig> =>
  Object.fromEntries(
    pools.flatMap((pool) => CLOUD_POOL_KINDS.map((kind) => instanceOf(kind, pool))),
  );

/** The pool and kind behind one of these instances, or null for any other instance. */
export const poolOfInstance = (
  pools: ReadonlyArray<UserPool>,
  instanceId: string,
): { readonly pool: UserPool; readonly kind: (typeof CLOUD_POOL_KINDS)[number] } | null => {
  for (const pool of pools) {
    for (const kind of CLOUD_POOL_KINDS) {
      if (instanceOf(kind, pool)[0] === instanceId) return { pool, kind };
    }
  }
  return null;
};
