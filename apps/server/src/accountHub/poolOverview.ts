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
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  type AccountPool,
  type AccountPoolOverview,
  hubInstancePoolId,
} from "@t3tools/contracts/accountHub";
import { hasQuota, pooledUsage, takesTurns } from "@t3tools/shared/poolUsage";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as AccountPools from "./AccountPools.ts";

/** Pools with the enabled providers each one runs, from settings, the registry, and usage at `now`. */
export function buildPoolOverviews(input: {
  readonly pools: ReadonlyArray<AccountPool>;
  readonly instances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly now: number;
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
        // OpenCode runs on every model the hub routes, so every account but Cursor's serves it.
        const own = accounts.filter((account) =>
          provider.driver === "opencode"
            ? account.driver !== "cursor"
            : account.driver === provider.driver,
        );
        return {
          providerInstanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? provider.driver,
          // The cloud reports a moved pool's limits, not this server: signed in is all it knows.
          available:
            pool.backing.mode === "cloud"
              ? provider.auth.status === "authenticated"
              : own.some((account) => hasQuota(account, input.now)),
          usage: pooledUsage(own, input.now),
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
    now: yield* Clock.currentTimeMillis,
  });
});
