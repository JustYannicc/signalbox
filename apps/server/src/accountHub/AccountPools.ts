/**
 * Pools: named sets of accounts that work spreads across, each with its own
 * hub. The personal pool is the hub every install already has (same files,
 * same instance ids), so upgrading needs no migration. Other pools keep their
 * hubs under `account-pools/<id>`.
 *
 * Every transport (RPC, MCP) goes through this service. A pool's backing
 * (Signalbox's own CLIProxyAPI or one the user runs) is a detail of the pool;
 * changing it rebuilds that pool's provider instances against the new hub.
 *
 * @module accountHub/AccountPools
 */
import {
  type AccountPool,
  type AccountPoolAddApiKeyInput,
  type AccountPoolMoveNativeLoginsInput,
  type AccountPoolMoveNativeLoginsResult,
  type AccountPoolCreateInput,
  type AccountPoolImportInput,
  type AccountPoolRenameInput,
  type AccountPoolSetBackingInput,
  type AccountHubImportResult,
  AccountPoolId,
  PERSONAL_POOL_ID,
  hubInstancePoolId,
  poolSourceId,
} from "@t3tools/contracts/accountHub";
import type { UsageLimitSourceConfig, UsageLimitSourceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import { HttpClient } from "effect/http";

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as AccountHub from "./AccountHub.ts";
import { AccountHubError } from "./accountHubManagement.ts";
import {
  configuredModels,
  hubModels,
  openCodeConfigPath,
  openCodeInstanceDirectory,
  sameModels,
} from "./hubOpenCode.ts";
import * as PoolCredentials from "./poolCredentials.ts";
import { type PoolInstanceKind, withPoolInstances } from "./poolInstances.ts";

type Hub = AccountHub.AccountHub["Service"];

interface PoolEntry {
  readonly id: AccountPoolId;
  readonly name: string;
  readonly placement: AccountHub.AccountHubPlacement;
  readonly hub: Hub;
  /** Closing it stops the hub; absent for the personal pool, which the server owns. */
  readonly scope?: Scope.Closeable;
}

const StoredPools = Schema.Struct({
  personalName: Schema.optional(Schema.String),
  pools: Schema.Array(Schema.Struct({ id: AccountPoolId, name: Schema.String })),
});
const decodeStoredPools = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredPools));
const encodeStoredPools = Schema.encodeEffect(Schema.fromJsonString(StoredPools));

const placementFor = (id: string): AccountHub.AccountHubPlacement => ({
  directory: `account-pools/${id}`,
  secretPrefix: `account-pool-${id}`,
  sourceId: poolSourceId(id),
});

const isHubInstanceOf = (config: unknown, poolId: string) => hubInstancePoolId(config) === poolId;

const notFound = () => new AccountHubError({ detail: "That pool no longer exists." });
const isAccountHubError = Schema.is(AccountHubError);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* Settings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const personalHub = yield* AccountHub.AccountHub;
  // Everything a hub needs, so pools created later get the same services.
  const hubContext =
    yield* Effect.context<
      Exclude<Effect.Services<ReturnType<typeof AccountHub.makeAccountHub>>, Scope.Scope>
    >();
  // What reading native logins needs (keychain, Signalbox's own stored sign-ins).
  const moveContext =
    yield* Effect.context<
      Exclude<Effect.Services<ReturnType<typeof PoolCredentials.moveNativeLogins>>, Scope.Scope>
    >();

  // Every hub's coming up, going down, and account changes, for usage limits to re-read.
  const activity = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const forwardActivity = (hub: Hub) =>
    Stream.merge(
      hub.statusChanges.pipe(
        Stream.map((status) => status.phase === "running"),
        Stream.changes,
        Stream.drop(1),
      ),
      hub.accountChanges,
    ).pipe(Stream.runForEach(() => PubSub.publish(activity, undefined)));

  const storePath = path.join(config.stateDir, "account-pools", "pools.json");
  const empty = { personalName: undefined, pools: [] };
  const stored = yield* fs.readFileString(storePath).pipe(
    Effect.flatMap((text) =>
      decodeStoredPools(text).pipe(
        // Unreadable: kept beside the fresh list instead of being overwritten.
        Effect.catch((cause) =>
          Effect.logError("account pools file is unreadable; starting fresh", { cause }).pipe(
            Effect.andThen(fs.rename(storePath, `${storePath}.unreadable`)),
            Effect.ignoreCause({ log: true }),
            Effect.as(empty),
          ),
        ),
      ),
    ),
    Effect.orElseSucceed(() => empty),
  );

  const startHub = Effect.fn("AccountPools.startHub")(function* (
    placement: AccountHub.AccountHubPlacement,
  ) {
    const scope = yield* Scope.make("sequential");
    const hub = yield* AccountHub.makeAccountHub(placement).pipe(
      Scope.provide(scope),
      Effect.provideContext(hubContext),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    yield* forwardActivity(hub).pipe(Effect.forkIn(scope));
    return { hub, scope };
  });

  const entries = yield* Ref.make<ReadonlyArray<PoolEntry>>([
    {
      id: AccountPoolId.make(PERSONAL_POOL_ID),
      name: stored.personalName?.trim() || "Personal",
      placement: AccountHub.PERSONAL_HUB,
      hub: personalHub,
    },
  ]);
  yield* forwardActivity(personalHub).pipe(Effect.forkScoped);
  for (const pool of stored.pools) {
    const placement = placementFor(pool.id);
    const started = yield* startHub(placement);
    yield* Ref.update(entries, (current) => [...current, { ...pool, placement, ...started }]);
  }
  yield* Effect.addFinalizer(() =>
    Ref.get(entries).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current, (entry) =>
          entry.scope ? Scope.close(entry.scope, Exit.void) : Effect.void,
        ),
      ),
    ),
  );

  const changed = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const gate = yield* Semaphore.make(1);

  const persist = Effect.gen(function* () {
    const current = yield* Ref.get(entries);
    const personal = current.find((entry) => entry.id === PERSONAL_POOL_ID);
    // Atomic, so a crash mid-write can't lose the list of pools.
    yield* writeFileStringAtomically({
      filePath: storePath,
      contents: yield* encodeStoredPools({
        ...(personal ? { personalName: personal.name } : {}),
        pools: current
          .filter((entry) => entry.id !== PERSONAL_POOL_ID)
          .map((entry) => ({ id: entry.id, name: entry.name })),
      }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    yield* PubSub.publish(changed, undefined);
  });

  const entry = (poolId: string) =>
    Ref.get(entries).pipe(
      Effect.flatMap((current) => {
        const found = current.find((candidate) => candidate.id === poolId);
        return found ? Effect.succeed(found) : Effect.fail(notFound());
      }),
    );

  const describe = (pool: PoolEntry): Effect.Effect<AccountPool> =>
    pool.hub.connection.pipe(
      Effect.map((backing) => ({
        id: pool.id,
        name: pool.name,
        sourceId: pool.placement.sourceId,
        backing,
        personal: pool.id === PERSONAL_POOL_ID,
      })),
    );

  const list = Ref.get(entries).pipe(
    Effect.flatMap((current) => Effect.forEach(current, describe)),
  );

  // A pool's instances read its hub address once, when built; bumping the
  // revision makes the provider registry rebuild them against the new hub.
  const rebuildInstances = (poolId: string) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings;
      const revision = yield* Clock.currentTimeMillis;
      yield* settings.updateSettings({
        providerInstances: Object.fromEntries(
          Object.entries(current.providerInstances).map(([id, instance]) => [
            id,
            isHubInstanceOf(instance.config, poolId)
              ? { ...instance, config: { ...(instance.config as object), hubRevision: revision } }
              : instance,
          ]),
        ),
      });
    });

  const fail = (detail: string) => (cause: unknown) =>
    isAccountHubError(cause) ? cause : new AccountHubError({ detail, cause });

  const create = (input: AccountPoolCreateInput) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const taken = new Set((yield* Ref.get(entries)).map((pool) => pool.id));
          const newId = crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => AccountPoolId.make(uuid.slice(0, 8))),
          );
          let id = yield* newId;
          while (taken.has(id)) id = yield* newId;
          const placement = placementFor(id);
          const started = yield* startHub(placement);
          const pool: PoolEntry = { id, name: input.name.trim(), placement, ...started };
          yield* Ref.update(entries, (current) => [...current, pool]);
          // Not saved means not created: undo, so memory and disk agree.
          yield* persist.pipe(
            Effect.tapError(() =>
              Ref.update(entries, (current) => current.filter((entry) => entry.id !== id)).pipe(
                Effect.andThen(Scope.close(started.scope, Exit.void)),
              ),
            ),
          );
          return yield* describe(pool);
        }),
      )
      .pipe(Effect.mapError(fail("Could not create the pool.")));

  const rename = (input: AccountPoolRenameInput) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          yield* entry(input.poolId);
          yield* Ref.update(entries, (current) =>
            current.map((candidate) =>
              candidate.id === input.poolId ? { ...candidate, name: input.name.trim() } : candidate,
            ),
          );
          yield* persist;
          return yield* describe(yield* entry(input.poolId));
        }),
      )
      .pipe(Effect.mapError(fail("Could not rename the pool.")));

  // The pool providers that run `kinds`, added where missing.
  const addPoolInstances = (pool: PoolEntry, kinds: Iterable<PoolInstanceKind>) =>
    settings.getSettings.pipe(
      Effect.flatMap((current) =>
        settings.updateSettings({
          providerInstances: withPoolInstances(current.providerInstances, pool, kinds),
        }),
      ),
    );

  const addApiKey = (input: AccountPoolAddApiKeyInput) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const pool = yield* entry(input.poolId);
          const kind = yield* PoolCredentials.addApiKey(pool.hub, input);
          yield* addPoolInstances(pool, [kind]);
        }),
      )
      .pipe(Effect.mapError(fail("Could not add the API key.")));

  const moveNativeLogins = (
    input: AccountPoolMoveNativeLoginsInput,
  ): Effect.Effect<AccountPoolMoveNativeLoginsResult, AccountHubError> =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const pool = yield* entry(input.poolId);
          const instances = deriveProviderInstanceConfigMap(yield* settings.getSettings);
          const { moved, failed, kinds } = yield* PoolCredentials.moveNativeLogins(
            pool.hub,
            instances,
            input.instanceIds,
          ).pipe(Effect.provideContext(moveContext));
          if (moved.length > 0) {
            // Read again: the moves above may have changed settings (a cleared sign-in).
            const current = yield* settings.getSettings;
            const next = withPoolInstances(current.providerInstances, pool, kinds);
            // The native instances go off, so nothing refreshes those logins but the pool.
            for (const instanceId of moved) {
              const instance = next[instanceId] ?? instances[instanceId];
              if (instance) next[instanceId] = { ...instance, enabled: false };
            }
            yield* settings.updateSettings({ providerInstances: next });
          }
          return { moved, failed };
        }),
      )
      .pipe(Effect.mapError(fail("Could not move the sign-ins.")));

  const remove = (poolId: string) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          if (poolId === PERSONAL_POOL_ID) {
            return yield* new AccountHubError({ detail: "The personal pool can't be deleted." });
          }
          const pool = yield* entry(poolId);
          // Its providers go first, taking their sign-ins and sessions with them, so nothing
          // asks the hub to start again while it is being stopped.
          const current = yield* settings.getSettings;
          yield* settings.updateSettings({
            providerInstances: Object.fromEntries(
              Object.entries(current.providerInstances).filter(
                ([, instance]) => !isHubInstanceOf(instance.config, poolId),
              ),
            ),
          });
          // Forgotten next, so a failed cleanup below never brings the pool back on restart.
          yield* Ref.update(entries, (pools) =>
            pools.filter((candidate) => candidate.id !== poolId),
          );
          yield* persist;
          if (pool.scope) yield* Scope.close(pool.scope, Exit.void);
          // The pool's own logins and keys go with it; an external backing is left untouched.
          yield* fs
            .remove(path.join(config.stateDir, pool.placement.directory), {
              recursive: true,
              force: true,
            })
            .pipe(Effect.ignoreCause({ log: true }));
          yield* Effect.forEach(Object.values(AccountHub.hubSecretNames(pool.placement)), (name) =>
            secrets.remove(name).pipe(Effect.ignoreCause({ log: true })),
          );
        }),
      )
      .pipe(Effect.mapError(fail("Could not delete the pool.")));

  const setBacking = (input: AccountPoolSetBackingInput) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const pool = yield* entry(input.poolId);
          yield* pool.hub.setConnection(input.backing);
          yield* rebuildInstances(input.poolId);
          yield* PubSub.publish(changed, undefined);
          return yield* describe(pool);
        }),
      )
      .pipe(Effect.mapError(fail("The backing changed, but its providers could not restart.")));

  const importAccounts = (
    input: AccountPoolImportInput,
  ): Effect.Effect<AccountHubImportResult, AccountHubError> =>
    // A deleted pool's hub refuses to start, so an import racing a delete fails cleanly.
    entry(input.poolId).pipe(
      Effect.flatMap((pool) =>
        pool.hub.importAccounts({
          url: input.url,
          managementKey: input.managementKey,
          removeFromSource: input.removeFromSource,
        }),
      ),
    );

  // OpenCode lists only the models its config names. When a pool's hub serves different
  // models than an OpenCode instance was built with, rebuild that instance.
  const syncOpenCodeModels = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    const stale = new Set<string>();
    for (const pool of yield* Ref.get(entries)) {
      const instanceIds = Object.entries(current.providerInstances)
        .filter(
          ([, instance]) =>
            instance.driver === "opencode" && isHubInstanceOf(instance.config, pool.id),
        )
        .map(([id]) => id);
      if (instanceIds.length === 0) continue;
      const endpoint = yield* pool.hub.endpoint;
      if (Option.isNone(endpoint)) continue;
      const served = yield* hubModels(endpoint.value).pipe(Effect.option);
      if (Option.isNone(served)) continue;
      for (const id of instanceIds) {
        const listed = yield* configuredModels(
          openCodeConfigPath(path, openCodeInstanceDirectory(path, config.stateDir, id)),
        );
        if (!sameModels(listed, served.value)) stale.add(id);
      }
    }
    if (stale.size === 0) return;
    const revision = yield* Clock.currentTimeMillis;
    yield* settings.updateSettings({
      providerInstances: Object.fromEntries(
        Object.entries(current.providerInstances).map(([id, instance]) => [
          id,
          stale.has(id)
            ? { ...instance, config: { ...(instance.config as object), hubRevision: revision } }
            : instance,
        ]),
      ),
    });
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.ignoreCause({ log: true }),
  );
  // A hub coming up or changing accounts is what changes its models. An instance built while its
  // hub already runs reads the models itself.
  yield* Stream.merge(Stream.fromPubSub(activity), Stream.fromPubSub(changed)).pipe(
    Stream.debounce("1 second"),
    Stream.runForEach(() => syncOpenCodeModels),
    Effect.forkScoped,
  );

  return AccountPools.of({
    list,
    // Subscribed before the first read, so a change in between is not missed.
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changed);
        const first = yield* list;
        return Stream.concat(
          Stream.make(first),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
        );
      }),
    ),
    hub: (poolId) => entry(poolId).pipe(Effect.map((pool) => pool.hub)),
    hubs: Ref.get(entries).pipe(
      Effect.map((current) =>
        current.map((pool) => ({ id: pool.id, name: pool.name, hub: pool.hub })),
      ),
    ),
    listChanges: Stream.fromPubSub(changed),
    activity: Stream.merge(Stream.fromPubSub(activity), Stream.fromPubSub(changed)),
    usageLimitSources: Ref.get(entries).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current, (pool) =>
          pool.hub.usageLimitSource.pipe(
            // Reported under the pool's own name.
            Effect.map(
              Option.map(([id, source]) => [id, { ...source, label: pool.name }] as const),
            ),
          ),
        ),
      ),
      Effect.map((sources) => sources.flatMap(Option.toArray)),
    ),
    markAccountsChanged: (sourceId) =>
      Ref.get(entries).pipe(
        Effect.flatMap((current) => {
          const pool = current.find((candidate) => candidate.placement.sourceId === sourceId);
          return pool ? pool.hub.markAccountsChanged : Effect.void;
        }),
      ),
    create,
    rename,
    remove,
    setBacking,
    importAccounts,
    addApiKey,
    moveNativeLogins,
  });
});

export class AccountPools extends Context.Service<
  AccountPools,
  {
    readonly list: Effect.Effect<ReadonlyArray<AccountPool>>;
    /** The pools now, then again after every change. */
    readonly changes: Stream.Stream<ReadonlyArray<AccountPool>>;
    /** Fires when a pool is created, renamed, deleted, or changes backing. */
    readonly listChanges: Stream.Stream<void>;
    /** Fires when any pool changes, or any pool's hub comes up, goes down, or changes accounts. */
    readonly activity: Stream.Stream<void>;
    /** Every pool's hub as a usage limit source, under the pool's name. */
    readonly usageLimitSources: Effect.Effect<
      ReadonlyArray<readonly [UsageLimitSourceId, UsageLimitSourceConfig]>
    >;
    /** Announces an account change made through a pool's usage source. */
    readonly markAccountsChanged: (sourceId: UsageLimitSourceId) => Effect.Effect<void>;
    readonly hub: (poolId: string) => Effect.Effect<Hub, AccountHubError>;
    readonly hubs: Effect.Effect<
      ReadonlyArray<{ readonly id: AccountPoolId; readonly name: string; readonly hub: Hub }>
    >;
    readonly create: (input: AccountPoolCreateInput) => Effect.Effect<AccountPool, AccountHubError>;
    readonly rename: (input: AccountPoolRenameInput) => Effect.Effect<AccountPool, AccountHubError>;
    readonly remove: (poolId: string) => Effect.Effect<void, AccountHubError>;
    readonly setBacking: (
      input: AccountPoolSetBackingInput,
    ) => Effect.Effect<AccountPool, AccountHubError>;
    /** Adds a pasted API key, and the pool provider that uses it when missing. */
    readonly addApiKey: (input: AccountPoolAddApiKeyInput) => Effect.Effect<void, AccountHubError>;
    /** Moves native logins into a pool and turns their instances off. */
    readonly moveNativeLogins: (
      input: AccountPoolMoveNativeLoginsInput,
    ) => Effect.Effect<AccountPoolMoveNativeLoginsResult, AccountHubError>;
    readonly importAccounts: (
      input: AccountPoolImportInput,
    ) => Effect.Effect<AccountHubImportResult, AccountHubError>;
  }
>()("t3/accountHub/AccountPools") {}

export const layer = Layer.effect(AccountPools, make);
