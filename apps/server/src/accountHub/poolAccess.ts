/**
 * What each caller may see of a pool. Admins get everything a pool holds.
 * Members get only its overview: what is left per provider and window and
 * when it next resets, with no account count, email, plan, or banked reset.
 * Every read payload that carries pool accounts passes through here on its
 * way to a client, so a client hiding a field is never the guard. Redeeming
 * resets and managing accounts need the operate scope, which makes a caller
 * an admin (see `RpcAuthorization.ts`).
 *
 * @module accountHub/poolAccess
 */
import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type ProviderInstanceConfig,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  type AccountPoolOverview,
  type AccountPoolRole,
  type AccountPoolView,
  hubInstancePoolId,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as AccountPools from "./AccountPools.ts";
import { listPoolOverviews } from "./poolOverview.ts";

/**
 * The caller's role in this environment's pools. Until pools are shared, a
 * session that may operate the environment administers them: it can already
 * run code beside their credentials. Anyone else is a member.
 */
export const poolRole = (scopes: ReadonlyArray<AuthEnvironmentScope>): AccountPoolRole =>
  scopes.includes(AuthOrchestrationOperateScope) ? "admin" : "member";

/** Usage sources list every account they report on, so only admins get them. */
export const visibleUsageLimitSources = (
  role: AccountPoolRole,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): ReadonlyArray<UsageLimitSourceSnapshot> => (role === "admin" ? sources : []);

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

/** Providers as `role` may see them; `instances` says which ones run on a pool. */
export const visibleProviders = (
  role: AccountPoolRole,
  providers: ReadonlyArray<ServerProvider>,
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): ReadonlyArray<ServerProvider> =>
  role === "admin"
    ? providers
    : providers.map((provider) =>
        hubInstancePoolId(instances[provider.instanceId]?.config) === null
          ? provider
          : memberProvider(provider),
      );

/** {@link visibleProviders} against current settings. Unreadable settings hide every provider's account. */
export const providersFor = (role: AccountPoolRole, providers: ReadonlyArray<ServerProvider>) =>
  role === "admin"
    ? Effect.succeed(providers)
    : Settings.ServerSettingsService.pipe(
        Effect.flatMap((settings) => settings.getSettings),
        Effect.map((settings) => visibleProviders(role, providers, settings.providerInstances)),
        Effect.orElseSucceed(() => providers.map(memberProvider)),
      );

export const withRole = (
  role: AccountPoolRole,
  overviews: ReadonlyArray<AccountPoolOverview>,
): ReadonlyArray<AccountPoolView> => overviews.map((overview) => ({ ...overview, role }));

/**
 * Every pool as `role` sees it, now and after every change to pools, their
 * usage, providers, or settings. The overview carries no account-level data,
 * so this one stream serves admins and members alike.
 */
export const poolViews = (role: AccountPoolRole) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pools = yield* AccountPools.AccountPools;
      const usage = yield* UsageLimitSources.UsageLimitSources;
      const registry = yield* ProviderRegistry.ProviderRegistry;
      const settings = yield* Settings.ServerSettingsService;
      return Stream.mergeAll(
        [
          // Replays the current usage first, so the stream opens with a view.
          Stream.as(usage.streamChanges, undefined),
          pools.listChanges,
          Stream.as(registry.streamChanges, undefined),
          Stream.as(settings.streamChanges, undefined),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapEffect(() => listPoolOverviews),
        Stream.map((overviews) => withRole(role, overviews)),
        Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
      );
    }),
  );
