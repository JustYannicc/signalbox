/**
 * Every pool as its members may see it: the providers it runs and, for each,
 * the share of quota left per window and the next reset. Built from the
 * pool's own usage source, so it never carries account counts, emails, plans,
 * or banked resets. Agents read it to pick a pool for a thread or task.
 *
 * @module accountHub/poolOverview
 */
import type {
  ProviderInstanceConfig,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  type AccountPool,
  type AccountPoolOverview,
  type AccountPoolUsageWindow,
  hubInstancePoolId,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as AccountPools from "./AccountPools.ts";

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** Accounts the pool routes turns to: paused and signed-out ones take none. */
const takesTurns = (account: UsageLimitSourceAccount) => !account.disabled && !account.signedOut;

/**
 * One provider's windows pooled across its accounts: the mean share left, as
 * the Limits view shows it, and the soonest reset that hands quota back.
 */
export function pooledUsage(
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
): ReadonlyArray<AccountPoolUsageWindow> {
  const byWindow = new Map<string, ServerProviderUsageWindow[]>();
  for (const account of accounts) {
    for (const window of account.usageLimits.windows) {
      const key = `${window.kind}:${window.id}`;
      byWindow.set(key, [...(byWindow.get(key) ?? []), window]);
    }
  }
  return [...byWindow.values()]
    .map((windows) => {
      const first = windows[0]!;
      const used =
        windows.reduce((sum, window) => sum + Math.max(0, Math.min(100, window.usedPercent)), 0) /
        windows.length;
      // An untouched account's reset gives nothing back.
      const nextResetAt = windows
        .filter((window) => window.usedPercent > 0 && window.resetsAt !== undefined)
        .map((window) => window.resetsAt!)
        .filter((at) => Number.isFinite(Date.parse(at)))
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
      return {
        label: first.label,
        kind: first.kind,
        remainingPercent: Math.round(100 - used),
        ...(nextResetAt ? { nextResetAt } : {}),
      };
    })
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

/** Pools with the enabled providers each one runs, from settings, the registry, and usage. */
export function buildPoolOverviews(input: {
  readonly pools: ReadonlyArray<AccountPool>;
  readonly instances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
}): ReadonlyArray<AccountPoolOverview> {
  return input.pools.map((pool) => {
    const accounts = (
      input.sources.find((source) => source.id === pool.sourceId)?.accounts ?? []
    ).filter(takesTurns);
    const providers = input.providers
      .filter(
        (provider) =>
          provider.enabled &&
          hubInstancePoolId(input.instances[provider.instanceId]?.config) === pool.id,
      )
      .map((provider) => {
        const own = accounts.filter((account) => account.driver === provider.driver);
        return {
          providerInstanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? provider.driver,
          available: own.length > 0,
          usage: pooledUsage(own),
        };
      });
    return { id: pool.id, name: pool.name, providers };
  });
}

/** The current overview of every pool. */
export const listPoolOverviews = Effect.gen(function* () {
  const pools = yield* AccountPools.AccountPools;
  const settings = yield* Settings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const usage = yield* UsageLimitSources.UsageLimitSources;
  return buildPoolOverviews({
    pools: yield* pools.list,
    instances: (yield* settings.getSettings).providerInstances,
    providers: yield* registry.getProviders,
    sources: yield* usage.current,
  });
});
