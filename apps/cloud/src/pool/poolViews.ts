import {
  type AccountHubConnection,
  type AccountPool,
  type AccountPoolOverview,
  type AccountPoolProvider,
  type PoolRouting,
  POOL_INSTANCE_KINDS,
  poolInstanceEntry,
  poolSourceId,
} from "@t3tools/contracts/accountHub";
import {
  type ProviderDriverKind,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { hasQuota, pooledUsage, takesTurns } from "@t3tools/shared/poolUsage";
import * as DateTime from "effect/DateTime";

import { CLOUD_POOL_KINDS, servesModel } from "../models/ModelRouting.ts";
import type { ServedModel } from "./cliProxyApi.ts";
import type { PoolAccounts, PoolRole } from "./PoolEngine.ts";
import { READS_LIMITS } from "./poolLimits.ts";

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

/** A pool with its accounts, as one usage limit source, and the models they serve. */
export interface PoolEntry {
  readonly pool: UserPool;
  /** Every account, for the overview and providers; `limitsSource` is what the user may see. */
  readonly source: UsageLimitSourceSnapshot;
  readonly models: ReadonlyArray<ServedModel>;
  /** The user's role in the pool, null when it couldn't be read. */
  readonly role: PoolRole | null;
  /** How it spreads turns, when the user may change it. */
  readonly routing: PoolRouting | null;
  /** Member-safe quota information held across a failed account read. */
  readonly lastKnownOverview?: AccountPoolOverview;
}

/** A pool as the user's clients list it, with its routing when they may change it. */
export const accountPool = (pool: UserPool, routing: PoolRouting | null = null): AccountPool => ({
  id: pool.id,
  name: pool.name,
  sourceId: poolSourceId(pool.id),
  backing: pool.backing,
  personal: pool.personal,
  ...(routing === null ? {} : { routing }),
});

/** CLIProxyAPI's credential types, as the drivers clients draw them with. */
const DRIVER_BY_ACCOUNT_TYPE: Record<string, ProviderDriverKind> = {
  claude: POOL_INSTANCE_KINDS.claude.driver,
  codex: POOL_INSTANCE_KINDS.codex.driver,
  xai: POOL_INSTANCE_KINDS.grok.driver,
  antigravity: POOL_INSTANCE_KINDS.antigravity.driver,
};

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const unavailable = (
  checkedAt: string,
  message: string,
  reason: "unsupported" | "probeFailed" = "unsupported",
) => makeUnavailableUsageLimits({ checkedAt, reason, message });

/** An account's windows, or why it has none. */
const usageLimitsOf = (
  account: PoolAccounts["accounts"][number],
  checkedAt: string,
): UsageLimitSourceAccount["usageLimits"] => {
  if (account.disabled) return unavailable(checkedAt, "Paused.");
  if (account.signedOut) return unavailable(checkedAt, "Signed out. Sign in again.");
  if (account.usageLimits !== null) return account.usageLimits;
  return READS_LIMITS.has(account.type)
    ? unavailable(
        checkedAt,
        "Not read yet. The pool reads it the next time it runs.",
        "probeFailed",
      )
    : unavailable(checkedAt, "Signalbox Cloud reads limits for Claude and ChatGPT accounts.");
};

/** The pool's accounts as one usage limit source, grouped under the pool in Limits. */
export const usageSource = (
  entry: { readonly pool: UserPool; readonly accounts: PoolAccounts | { readonly error: string } },
  now: number,
): UsageLimitSourceSnapshot => {
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
          usageLimits: usageLimitsOf(account, at),
          ...(account.disabled ? { disabled: true } : {}),
          ...(account.signedOut ? { signedOut: true } : {}),
        },
      ];
    }),
    ...(error ? { error } : {}),
  };
};

/** What the user may see in Limits: each account for admins, none for members. */
export const limitsSource = (entry: PoolEntry): UsageLimitSourceSnapshot =>
  entry.role === "admin" ? entry.source : { ...entry.source, accounts: [] };

/** `driver`'s accounts in `source` that take turns. */
const running = (source: UsageLimitSourceSnapshot, driver: ProviderDriverKind) =>
  source.accounts.filter((account) => account.driver === driver && takesTurns(account));

/** Whether `source` holds an account of `driver` that can take turns. */
const canRun = (source: UsageLimitSourceSnapshot, driver: ProviderDriverKind) =>
  running(source, driver).length > 0;

/** Stale reads must not revive providers whose accounts were signed out or paused. */
export const modelsForSnapshot = (entry: PoolEntry): ReadonlyArray<ServedModel> =>
  entry.lastKnownOverview !== undefined
    ? entry.models
    : entry.models.filter((model) =>
        CLOUD_POOL_KINDS.some(
          (kind) =>
            canRun(entry.source, POOL_INSTANCE_KINDS[kind].driver) &&
            servesModel(kind, [model], model.id),
        ),
      );

const instanceOf = (kind: (typeof CLOUD_POOL_KINDS)[number], pool: UserPool) =>
  poolInstanceEntry(kind, { id: pool.id, name: pool.personal ? undefined : pool.name });

/**
 * What any member may see: per provider, whether an account has quota left
 * now, and the share left per window with the next reset, pooled across the
 * accounts. No account count, emails or plans.
 */
export const overview = (
  pool: UserPool,
  source: UsageLimitSourceSnapshot,
  now: number,
): AccountPoolOverview => ({
  id: pool.id,
  name: pool.name,
  checkedAt: source.checkedAt,
  ...(source.error ? { error: source.error } : {}),
  providers: CLOUD_POOL_KINDS.map((kind): AccountPoolProvider => {
    const [providerInstanceId] = instanceOf(kind, pool);
    const { driver, displayName } = POOL_INSTANCE_KINDS[kind];
    const accounts = running(source, driver);
    return {
      providerInstanceId,
      driver,
      displayName,
      available: accounts.some((account) => hasQuota(account, now)),
      usage: pooledUsage(accounts, now),
    };
  }),
});

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
