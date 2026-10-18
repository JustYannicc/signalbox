import {
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type ServerConfigStreamEvent,
  type ProviderInstanceMutation,
  type ServerProvider,
  type ServerSettingsPatch,
  WS_METHODS,
  ServerSettingsError,
} from "@t3tools/contracts";
import { AccountHubRpcError } from "@t3tools/contracts/accountHub";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Environment from "../environment.ts";
import { accountPool, limitsSource, overview } from "../pool/poolViews.ts";
import type { PoolActor } from "../pool/PoolEngine.ts";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import * as PoolSignIns from "./PoolSignIns.ts";
import * as UserPools from "./UserPools.ts";
import * as UserModelSettings from "./UserModelSettings.ts";
import * as UserKeybindings from "./UserKeybindings.ts";

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
  WS_METHODS.accountPoolSubscribeAdvice,
  WS_METHODS.accountPoolCreate,
  WS_METHODS.accountPoolRename,
  WS_METHODS.accountPoolDelete,
  WS_METHODS.accountPoolSetBacking,
  WS_METHODS.accountPoolImportAccounts,
  WS_METHODS.accountPoolAddApiKey,
  WS_METHODS.accountPoolMoveNativeLogins,
  WS_METHODS.accountPoolSetOpenCode,
  WS_METHODS.accountPoolSetRouting,
  WS_METHODS.accountPoolReceive,
  WS_METHODS.accountPoolMoveToCloud,
  WS_METHODS.usageLimitSourceUpdateAccount,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.providerAuthSubscribe,
  WS_METHODS.providerAuthStart,
  WS_METHODS.providerAuthComplete,
  WS_METHODS.providerAuthCancel,
  WS_METHODS.providerAuthRespond,
  WS_METHODS.providerAuthLogout,
] as const;

/** The scopes a self-hosted server requires for these (`apps/server/src/accountHub/poolRpcScopes.ts`). */
export const POOL_REQUIRED_SCOPES = {
  [WS_METHODS.accountPoolSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSubscribeViews]: AuthOrchestrationReadScope,
  [WS_METHODS.accountPoolSubscribeAdvice]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolCreate]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolRename]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolDelete]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetBacking]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolImportAccounts]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolAddApiKey]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolMoveNativeLogins]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetOpenCode]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetRouting]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolReceive]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolMoveToCloud]: AuthProvidersManageScope,
  [WS_METHODS.usageLimitSourceUpdateAccount]: AuthProvidersManageScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
} as const satisfies Record<(typeof POOL_METHODS)[number], AuthEnvironmentScope>;

/** What pools the cloud can't hold yet say instead of failing as unknown requests. */
const notYet = (what: string) =>
  Effect.fail(new AccountHubRpcError({ detail: `Signalbox Cloud pools can't ${what} yet.` }));

const now = Effect.map(DateTime.now, DateTime.formatIso);

const NO_POOLS: UserPools.PoolsState = [];

const availableModelsOf = (providers: ReadonlyArray<ServerProvider>) =>
  new Map(
    providers.map((provider) => [
      provider.instanceId,
      new Set(provider.models.map((model) => model.slug)),
    ]),
  );

const serverSettingsError = (operation: "normalize" | "write-file" = "normalize") =>
  new ServerSettingsError({ settingsPath: "cloud model settings", operation });

/** What settings say about the pools: their instances, named after them, and the default model. */
const settingsKey = (config: ReturnType<typeof Environment.serverConfig>) =>
  JSON.stringify([
    config.settings.providerInstances,
    config.settings.defaultModelSelection,
    config.settings.favorites,
    config.settings.providerModelPreferences,
  ]);

/** Up to 30 seconds between reads of pools that can't be read right now. */
const READ_AGAIN = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
  Schedule.jittered,
);

/**
 * The pools, read again when a read fails instead of ending. A client keeps a
 * failed subscription's last value until it reloads, so one failed read (a
 * pool object down while this one starts) would hide every pool created
 * after it from the sidebar and composer.
 */
const followPools = (pools: UserPools.UserPools["Service"], actor: PoolActor) =>
  pools.changes(actor).pipe(
    Stream.tapCause((cause) => Effect.logWarning("cloud pools unavailable, reading again", cause)),
    Stream.retry(READ_AGAIN),
  );

/**
 * The pools for the server config: none while they can't be read, so the
 * rest of the config still reaches the client, then the pools once they can.
 */
const poolStates = (pools: UserPools.UserPools["Service"], actor: PoolActor) =>
  pools.changes(actor).pipe(
    Stream.catchCause((cause) =>
      Stream.concat(
        Stream.fromEffect(
          Effect.logError("cloud pools unavailable for the server config", cause).pipe(
            Effect.as(NO_POOLS),
          ),
        ),
        // It reads again for as long as it takes, so it never fails.
        followPools(pools, actor).pipe(Stream.orDie),
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
    const catalog = yield* ModelCatalog.ModelCatalog;
    const modelSettings = yield* UserModelSettings.UserModelSettings;
    const keybindings = yield* UserKeybindings.UserKeybindings;
    const { actor, identity } = input;
    const configNowOf = (state: UserPools.PoolsState) =>
      Effect.flatMap(now, (checkedAt) =>
        Effect.map(catalog.view({ pools: state, checkedAt }), (view) =>
          Environment.serverConfig(identity, checkedAt, view),
        ),
      );
    const withModelSettings = (
      config: ReturnType<typeof Environment.serverConfig>,
      saved: UserModelSettings.ModelSettingsSnapshot,
    ) => {
      const filtered = UserModelSettings.filterAvailableModels(
        saved,
        availableModelsOf(config.providers),
      );
      return {
        ...config,
        settings: {
          ...config.settings,
          favorites: filtered.favorites,
          providerModelPreferences: filtered.providerModelPreferences,
          defaultModelSelection:
            saved.defaultModelSelection ?? config.settings.defaultModelSelection,
        },
      };
    };
    const configWithPreferences = (state: UserPools.PoolsState) =>
      Effect.all([
        configNowOf(state),
        modelSettings.snapshot.pipe(Effect.orDie),
        keybindings.snapshot.pipe(Effect.orDie),
      ]).pipe(
        Effect.map(([config, saved, bindings]) => ({
          ...withModelSettings(config, saved),
          keybindings: bindings.keybindings,
        })),
      );

    const configStream = (request: { readonly usageLimitSources?: boolean | undefined }) =>
      Stream.merge(
        Stream.merge(
          poolStates(pools, actor).pipe(Stream.map((state) => ({ type: "pools" as const, state }))),
          modelSettings.changes.pipe(
            Stream.orDie,
            Stream.map((settings) => ({ type: "settings" as const, settings })),
          ),
        ),
        keybindings.changes.pipe(
          Stream.orDie,
          Stream.map((bindings) => ({ type: "keybindings" as const, bindings })),
        ),
      ).pipe(
        Stream.mapAccum(
          (): {
            readonly state: UserPools.PoolsState | null;
            readonly settings: UserModelSettings.ModelSettingsSnapshot | null;
            readonly bindings: UserKeybindings.KeybindingsSnapshot | null;
          } => ({ state: null, settings: null, bindings: null }),
          (previous, change) => {
            const next =
              change.type === "pools"
                ? { ...previous, state: change.state }
                : change.type === "keybindings"
                  ? { ...previous, bindings: change.bindings }
                  : { ...previous, settings: change.settings };
            return [
              next,
              next.state === null || next.settings === null || next.bindings === null
                ? []
                : [{ state: next.state, saved: next.settings, bindings: next.bindings }],
            ];
          },
        ),
        Stream.mapEffect(({ state, saved, bindings }) =>
          Effect.map(configNowOf(state), (config) => ({
            state,
            bindingsRevision: bindings.revision,
            config: { ...withModelSettings(config, saved), keybindings: bindings.keybindings },
          })),
        ),
        Stream.mapAccum(
          (): { readonly settings: string; readonly bindings: number } | null => null,
          (previous, { state, config, bindingsRevision }) => {
            const key = settingsKey(config);
            return [
              { settings: key, bindings: bindingsRevision },
              [
                {
                  state,
                  config,
                  first: previous === null,
                  settingsChanged: key !== previous?.settings,
                  bindingsChanged: bindingsRevision !== previous?.bindings,
                },
              ],
            ];
          },
        ),
        Stream.map(
          ({
            state,
            config,
            first,
            settingsChanged,
            bindingsChanged,
          }): ReadonlyArray<ServerConfigStreamEvent> => {
            const sources: ReadonlyArray<ServerConfigStreamEvent> = request.usageLimitSources
              ? [
                  {
                    version: 1,
                    type: "usageLimitSourcesUpdated",
                    payload: { sources: state.map(limitsSource) },
                  },
                ]
              : [];
            if (first) return [{ version: 1, type: "snapshot", config }, ...sources];
            return [
              ...(bindingsChanged
                ? [
                    {
                      version: 1,
                      type: "keybindingsUpdated",
                      payload: { keybindings: config.keybindings, issues: [] },
                    } as const,
                  ]
                : []),
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
      configWithPreferences,
    );

    const updateModelSettings = (input: {
      readonly patch: ServerSettingsPatch;
      readonly providerInstanceMutation?: ProviderInstanceMutation;
    }) =>
      Effect.gen(function* () {
        if (input.providerInstanceMutation !== undefined) {
          return yield* Effect.fail(serverSettingsError());
        }
        const config = yield* configNow;
        const saved = yield* modelSettings
          .update(input.patch, availableModelsOf(config.providers))
          .pipe(
            Effect.catchTags({
              ModelSettingsWriteError: () => Effect.fail(serverSettingsError()),
              SqlError: (cause) =>
                Effect.logError("cloud model settings write failed", { cause }).pipe(
                  Effect.andThen(Effect.fail(serverSettingsError("write-file"))),
                ),
            }),
          );
        return withModelSettings(config, saved).settings;
      });

    const handlers = {
      [WS_METHODS.accountPoolSubscribeAdvice]: () =>
        pools.advice(actor).pipe(
          Stream.tapCause((cause) =>
            Effect.logWarning("cloud pools unavailable, reading again", cause),
          ),
          Stream.retry(READ_AGAIN),
        ),
      [WS_METHODS.accountPoolSubscribe]: () =>
        followPools(pools, actor).pipe(
          Stream.map((state) => state.map((entry) => accountPool(entry.pool, entry.routing))),
        ),
      [WS_METHODS.accountPoolSubscribeViews]: () =>
        followPools(pools, actor).pipe(
          Stream.mapEffect((state) =>
            Effect.map(Clock.currentTimeMillis, (now) =>
              state.map(
                (entry) => entry.lastKnownOverview ?? overview(entry.pool, entry.source, now),
              ),
            ),
          ),
        ),
      [WS_METHODS.accountPoolCreate]: (request: Parameters<typeof pools.create>[1]) =>
        pools.create(actor, request),
      [WS_METHODS.accountPoolRename]: (request: Parameters<typeof pools.rename>[1]) =>
        pools.rename(actor, request),
      [WS_METHODS.accountPoolSetRouting]: (request: Parameters<typeof pools.setRouting>[1]) =>
        pools.setRouting(actor, request),
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
      [WS_METHODS.providerAuthRespond]: (request: Parameters<typeof signIns.respond>[1]) =>
        signIns.respond(actor, request),
      [WS_METHODS.providerAuthLogout]: (request: Parameters<typeof signIns.logout>[1]) =>
        signIns.logout(actor, request),
      [WS_METHODS.serverUpdateSettings]: updateModelSettings,
    };
    return { handlers, configStream, configNow, updateModelSettings };
  });
