/**
 * What each caller may see of a pool. Admins get everything a pool holds.
 * Members get only its overview: what is left per provider and window and
 * when it next resets, with no account count, email, plan, or banked reset.
 * Every read payload that carries pool accounts passes through here on its
 * way to a client, so a client hiding a field is never the guard. Redeeming
 * resets and managing accounts need the providers scope, which makes a caller
 * an admin (see `poolRpcScopes.ts`).
 *
 * @module accountHub/poolAccess
 */
import {
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { hubInstancePoolId } from "@t3tools/contracts/accountHub";
import type { ServerSettings } from "@t3tools/contracts/settings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as AccountPools from "./AccountPools.ts";
import { listPoolOverviews } from "./poolOverview.ts";

export type PoolRole = "admin" | "member";

/**
 * The caller's role in this environment's pools. Until pools are shared, a
 * session that may manage providers administers them: it can already sign
 * accounts in and out. Anyone else is a member.
 */
export const poolRole = (scopes: ReadonlyArray<AuthEnvironmentScope>): PoolRole =>
  scopes.includes(AuthProvidersManageScope) ? "admin" : "member";

const NO_SOURCES: ReadonlyArray<UsageLimitSourceSnapshot> = [];

/** Usage sources list every account they report on, so only admins get them. */
export const visibleUsageLimitSources = (
  role: PoolRole,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
) => (role === "admin" ? sources : NO_SOURCES);

/** {@link visibleUsageLimitSources} for a change stream: a member hears once that there are none. */
export const visibleUsageLimitSourceChanges = (
  role: PoolRole,
  changes: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>,
) => (role === "admin" ? changes : Stream.make(NO_SOURCES));

/**
 * A pool provider as a member sees it. Its sign-in carries an account count
 * or one account's email and plan, and its windows and banked resets are
 * whichever account answered the probe; the pool's overview replaces both.
 */
const memberProvider = ({
  usageLimits: _account,
  ...provider
}: ServerProvider): ServerProvider => ({
  ...provider,
  auth: { status: provider.auth.status },
});

/** Providers as `role` may see them; `settings` says which ones run on a pool. */
export const visibleProviders = (
  role: PoolRole,
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
): ReadonlyArray<ServerProvider> => {
  if (role === "admin") return providers;
  // Read the registry's view, which includes the default instances settings leave implicit.
  const instances = deriveProviderInstanceConfigMap(settings);
  return providers.map((provider) =>
    hubInstancePoolId(instances[provider.instanceId]?.config) === null
      ? provider
      : memberProvider(provider),
  );
};

/** {@link visibleProviders} against current settings. Unreadable settings hide every provider's account. */
export const providersFor = (role: PoolRole, providers: ReadonlyArray<ServerProvider>) =>
  role === "admin"
    ? Effect.succeed(providers)
    : Settings.ServerSettingsService.pipe(
        Effect.flatMap((settings) => settings.getSettings),
        Effect.map((settings) => visibleProviders(role, providers, settings)),
        Effect.orElseSucceed(() => providers.map(memberProvider)),
      );

/**
 * Every pool's overview, now and after every change to pools, their usage,
 * providers, or settings. Overviews carry no account data, so admins and
 * members get the same stream. A failed read skips that update.
 */
export const poolViews = Stream.unwrap(
  Effect.gen(function* () {
    const pools = yield* AccountPools.AccountPools;
    const usage = yield* UsageLimitSources.UsageLimitSources;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const settings = yield* Settings.ServerSettingsService;
    const changes = Stream.mergeAll(
      [
        pools.listChanges,
        Stream.as(usage.streamChanges, undefined),
        Stream.as(registry.streamChanges, undefined),
        Stream.as(settings.streamChanges, undefined),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      // One pool edit fires several of these at once; build the overview once for all of them.
      Stream.debounce(Duration.millis(200)),
    );
    return Stream.concat(Stream.make(undefined), changes).pipe(
      Stream.mapEffect(() => Effect.option(listPoolOverviews)),
      Stream.filter(Option.isSome),
      Stream.map((overviews) => overviews.value),
      Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
    );
  }),
);
