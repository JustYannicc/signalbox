import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type ServerConfigStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { AccountHubRpcError } from "@t3tools/contracts/accountHub";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Environment from "../environment.ts";
import { accountPool, overview, poolProviderInstances, poolProviders } from "../pool/poolViews.ts";
import type { PoolActor } from "../pool/PoolEngine.ts";
import * as PoolSignIns from "./PoolSignIns.ts";
import * as UserPools from "./UserPools.ts";

/**
 * The account pool RPCs the cloud serves, all from the user's own object: the
 * pool list and its member-safe overviews, creating, renaming and deleting
 * pools, connecting a pool to an admin's own CLIProxyAPI, signing accounts
 * in, and pausing or removing them. The pools also reach the server config:
 * each pool's provider instances, and one usage limit source per pool.
 */

export const POOL_METHODS = [
  WS_METHODS.accountPoolSubscribe,
  WS_METHODS.accountPoolSubscribeViews,
  WS_METHODS.accountPoolCreate,
  WS_METHODS.accountPoolRename,
  WS_METHODS.accountPoolDelete,
  WS_METHODS.accountPoolSetBacking,
  WS_METHODS.accountPoolImportAccounts,
  WS_METHODS.accountPoolAddApiKey,
  WS_METHODS.accountPoolMoveNativeLogins,
  WS_METHODS.accountPoolSetOpenCode,
  WS_METHODS.usageLimitSourceUpdateAccount,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.providerAuthSubscribe,
  WS_METHODS.providerAuthStart,
  WS_METHODS.providerAuthComplete,
  WS_METHODS.providerAuthCancel,
] as const;

/** The scopes a self-hosted server requires for these (`apps/server/src/accountHub/poolRpcScopes.ts`). */
export const POOL_REQUIRED_SCOPES = {
  [WS_METHODS.accountPoolSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSubscribeViews]: AuthOrchestrationReadScope,
  [WS_METHODS.accountPoolCreate]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolRename]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolDelete]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetBacking]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolImportAccounts]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolAddApiKey]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolMoveNativeLogins]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetOpenCode]: AuthProvidersManageScope,
  [WS_METHODS.usageLimitSourceUpdateAccount]: AuthProvidersManageScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
} as const satisfies Record<(typeof POOL_METHODS)[number], AuthEnvironmentScope>;

/** What pools the cloud can't hold yet say instead of failing as unknown requests. */
const notYet = (what: string) =>
  Effect.fail(new AccountHubRpcError({ detail: `Signalbox Cloud pools can't ${what} yet.` }));

const now = Effect.map(DateTime.now, DateTime.formatIso);

/** The server config with the user's pools in it. */
const configOf = (
  identity: Environment.CloudEnvironmentIdentity,
  state: UserPools.PoolsState,
  checkedAt: string,
) => {
  return Environment.serverConfig(identity, checkedAt, {
    providers: poolProviders(state, checkedAt),
    instances: poolProviderInstances(state.map((entry) => entry.pool)),
  });
};

const NO_POOLS: UserPools.PoolsState = [];

/** What settings say about the pools: their instances, named after the pools. */
const settingsKey = (state: UserPools.PoolsState) =>
  state.map(({ pool }) => `${pool.id}\u0000${pool.name}`).join("\u0001");

/**
 * The pools, falling back to none when they can't be read, so the rest of
 * the config still reaches the client.
 */
const poolStates = (pools: UserPools.UserPools["Service"], actor: PoolActor) =>
  pools
    .changes(actor)
    .pipe(
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logError("cloud pools unavailable for the server config", cause).pipe(
            Effect.as(NO_POOLS),
          ),
        ),
      ),
    );

export const makePoolHandlers = (input: {
  readonly identity: Environment.CloudEnvironmentIdentity;
  readonly actor: PoolActor;
}) =>
  Effect.gen(function* () {
    const pools = yield* UserPools.UserPools;
    const signIns = yield* PoolSignIns.PoolSignIns;
    const { actor, identity } = input;

    /**
     * `subscribeServerConfig`: a snapshot, then each pool change as updates.
     * Settings only change with the pool list, so they go out only then.
     */
    const configStream = (request: { readonly usageLimitSources?: boolean | undefined }) =>
      poolStates(pools, actor).pipe(
        Stream.mapAccum(
          (): string | null => null,
          (previous, state) => {
            const key = settingsKey(state);
            return [key, [{ state, first: previous === null, settingsChanged: key !== previous }]];
          },
        ),
        Stream.mapEffect(({ state, first, settingsChanged }) =>
          Effect.map(now, (checkedAt): ReadonlyArray<ServerConfigStreamEvent> => {
            const config = configOf(identity, state, checkedAt);
            const sources: ReadonlyArray<ServerConfigStreamEvent> = request.usageLimitSources
              ? [
                  {
                    version: 1,
                    type: "usageLimitSourcesUpdated",
                    payload: { sources: state.map((entry) => entry.source) },
                  },
                ]
              : [];
            if (first) return [{ version: 1, type: "snapshot", config }, ...sources];
            return [
              ...(settingsChanged
                ? [
                    {
                      version: 1,
                      type: "settingsUpdated",
                      payload: { settings: config.settings },
                    } as const,
                  ]
                : []),
              { version: 1, type: "providerStatuses", payload: { providers: config.providers } },
              ...sources,
            ];
          }),
        ),
        Stream.flattenIterable,
        // A config stream that ends tells the client to reconnect.
        (stream) => Stream.concat(stream, Stream.never),
      );

    const configNow = Effect.gen(function* () {
      const state = yield* pools.state(actor).pipe(Effect.orElseSucceed(() => NO_POOLS));
      return configOf(identity, state, yield* now);
    });

    const handlers = {
      [WS_METHODS.accountPoolSubscribe]: () =>
        pools
          .changes(actor)
          .pipe(Stream.map((state) => state.map((entry) => accountPool(entry.pool)))),
      [WS_METHODS.accountPoolSubscribeViews]: () =>
        pools
          .changes(actor)
          .pipe(Stream.map((state) => state.map((entry) => overview(entry.pool, entry.source)))),
      [WS_METHODS.accountPoolCreate]: (request: Parameters<typeof pools.create>[1]) =>
        pools.create(actor, request),
      [WS_METHODS.accountPoolRename]: (request: Parameters<typeof pools.rename>[1]) =>
        pools.rename(actor, request),
      [WS_METHODS.accountPoolDelete]: (request: Parameters<typeof pools.delete>[1]) =>
        pools.delete(actor, request),
      [WS_METHODS.accountPoolSetBacking]: (request: Parameters<typeof pools.setBacking>[1]) =>
        pools.setBacking(actor, request),
      [WS_METHODS.accountPoolImportAccounts]: () => notYet("import accounts"),
      [WS_METHODS.accountPoolAddApiKey]: () => notYet("take API keys"),
      [WS_METHODS.accountPoolMoveNativeLogins]: () => notYet("take logins from this machine"),
      [WS_METHODS.accountPoolSetOpenCode]: () => notYet("run OpenCode"),
      [WS_METHODS.usageLimitSourceUpdateAccount]: (
        request: Parameters<typeof pools.updateAccount>[1],
      ) => pools.updateAccount(actor, request),
      // Usage → Limits asks when it opens; the pools read their accounts again.
      [WS_METHODS.serverRefreshProviders]: () =>
        Effect.gen(function* () {
          const state = yield* pools.refresh(actor).pipe(Effect.orElseSucceed(() => NO_POOLS));
          return { providers: configOf(identity, state, yield* now).providers };
        }),
      [WS_METHODS.providerAuthSubscribe]: (request: Parameters<typeof signIns.subscribe>[1]) =>
        signIns.subscribe(actor, request),
      [WS_METHODS.providerAuthStart]: (request: Parameters<typeof signIns.start>[1]) =>
        signIns.start(actor, request),
      [WS_METHODS.providerAuthComplete]: (request: Parameters<typeof signIns.complete>[1]) =>
        signIns.complete(actor, request),
      [WS_METHODS.providerAuthCancel]: (request: Parameters<typeof signIns.cancel>[1]) =>
        signIns.cancel(actor, request),
    };
    return { handlers, configStream, configNow };
  });
