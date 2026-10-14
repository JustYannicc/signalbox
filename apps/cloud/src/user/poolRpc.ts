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

import type { ModelManifestCatalogs } from "@t3tools/shared/modelManifest";

import * as Environment from "../environment.ts";
import {
  accountPool,
  overview,
  poolDefaultModelSelection,
  poolProviderInstances,
  poolProviders,
} from "../pool/poolViews.ts";
import type { PoolActor } from "../pool/PoolEngine.ts";
import * as ModelManifest from "../thread/ModelManifest.ts";
import * as PoolSignIns from "./PoolSignIns.ts";
import * as UserPools from "./UserPools.ts";

/**
 * The account pool RPCs the cloud serves, all from the user's own object: the
 * pool list and its member-safe overviews, creating, renaming and deleting
 * pools, connecting a pool to an admin's own CLIProxyAPI, signing accounts
 * in, pausing or removing them, and receiving a pool another server moves
 * here (`pool/poolLink.ts`). The pools also reach the server config:
 * each pool's provider instances with the models it serves, the model new
 * threads start on, and one usage limit source per pool.
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
  WS_METHODS.accountPoolReceive,
  WS_METHODS.accountPoolMoveToCloud,
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
  [WS_METHODS.accountPoolReceive]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolMoveToCloud]: AuthProvidersManageScope,
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
  manifest: ModelManifestCatalogs,
) => {
  const providers = poolProviders(state, checkedAt, manifest);
  return Environment.serverConfig(identity, checkedAt, {
    providers,
    instances: poolProviderInstances(state.map((entry) => entry.pool)),
    defaultModelSelection: poolDefaultModelSelection(providers),
  });
};

const NO_POOLS: UserPools.PoolsState = [];

/** What settings say about the pools: their instances, named after them, and the default model. */
const settingsKey = (config: ReturnType<typeof configOf>) =>
  JSON.stringify([config.settings.providerInstances, config.settings.defaultModelSelection]);

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
    const manifest = yield* ModelManifest.ModelManifest;
    const { actor, identity } = input;
    const configNowOf = (state: UserPools.PoolsState) =>
      Effect.all([now, manifest.current]).pipe(
        Effect.map(([checkedAt, catalogs]) => configOf(identity, state, checkedAt, catalogs)),
      );

    /**
     * `subscribeServerConfig`: a snapshot, then each pool change as updates.
     * Settings change with the pool list and the model new threads start on,
     * so they go out only then.
     */
    const configStream = (request: { readonly usageLimitSources?: boolean | undefined }) =>
      poolStates(pools, actor).pipe(
        Stream.mapEffect((state) =>
          Effect.map(configNowOf(state), (config) => ({ state, config })),
        ),
        Stream.mapAccum(
          (): string | null => null,
          (previous, { state, config }) => {
            const key = settingsKey(config);
            return [
              key,
              [{ state, config, first: previous === null, settingsChanged: key !== previous }],
            ];
          },
        ),
        Stream.map(
          ({ state, config, first, settingsChanged }): ReadonlyArray<ServerConfigStreamEvent> => {
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
          },
        ),
        Stream.flattenIterable,
        // A config stream that ends tells the client to reconnect.
        (stream) => Stream.concat(stream, Stream.never),
      );

    const configNow = Effect.flatMap(
      pools.state(actor).pipe(Effect.orElseSucceed(() => NO_POOLS)),
      configNowOf,
    );

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
      [WS_METHODS.accountPoolReceive]: (request: Parameters<typeof pools.receive>[1]) =>
        pools.receive(actor, request),
      [WS_METHODS.accountPoolMoveToCloud]: () =>
        Effect.fail(new AccountHubRpcError({ detail: "This pool is already in Signalbox Cloud." })),
      [WS_METHODS.usageLimitSourceUpdateAccount]: (
        request: Parameters<typeof pools.updateAccount>[1],
      ) => pools.updateAccount(actor, request),
      // Usage → Limits asks when it opens; the pools read their accounts again.
      [WS_METHODS.serverRefreshProviders]: () =>
        Effect.gen(function* () {
          const state = yield* pools.refresh(actor).pipe(Effect.orElseSucceed(() => NO_POOLS));
          return { providers: (yield* configNowOf(state)).providers };
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
