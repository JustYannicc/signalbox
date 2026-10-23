import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitHub from "../github/GitHub.ts";
import * as GitHubConnection from "../github/GitHubConnection.ts";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import * as ModelManifest from "../models/ModelManifest.ts";
import * as Platform from "../platform.ts";
import * as PoolDirectory from "../pool/PoolDirectory.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import * as ThreadKindTurns from "../thread/ThreadKindTurns.ts";
import * as KindClassifier from "../threadKinds/KindClassifier.ts";
import * as OnePasswordAccount from "./OnePasswordAccount.ts";
import * as ResourceBindings from "./ResourceBindings.ts";
import * as ThreadContextLayers from "./threadContextLayers.ts";
import * as ThreadContexts from "./threadContexts.ts";
import * as UserContexts from "./UserContexts.ts";
import * as UserDirectory from "./UserDirectory.ts";
import * as UserDrives from "./UserDrives.ts";
import * as UserFolders from "./UserFolders.ts";
import * as UserModelSettings from "./UserModelSettings.ts";
import * as UserPools from "./UserPools.ts";
import * as UserStore from "./UserStore.ts";
import * as UserThreadKinds from "./UserThreadKinds.ts";
import * as LocalChatArchiveAlarm from "./LocalChatArchiveAlarm.ts";
import * as ChatArchive from "./chatArchive.ts";

export interface LocalUserOptions<
  DatabaseError,
  DatabaseRequirements,
  PoolError,
  PoolRequirements,
> {
  readonly sql: Layer.Layer<SqlClient.SqlClient, DatabaseError, DatabaseRequirements>;
  readonly profile?: UserStore.LocalProfileInput;
  /** Durable Object hosts inject their storage-backed alarm; local tests use the scoped timer. */
  readonly chatArchiveAlarm?: Layer.Layer<ChatArchive.ChatArchiveAlarm>;
  readonly pools: (
    ownerId: string,
  ) => Effect.Effect<PoolDirectory.PoolDirectory["Service"], PoolError, PoolRequirements>;
}

type LocalUserStoreOptions<DatabaseError, DatabaseRequirements> = {
  readonly sql: Layer.Layer<SqlClient.SqlClient, DatabaseError, DatabaseRequirements>;
  readonly profile?: UserStore.LocalProfileInput;
};

const openLocalUserStore = <DatabaseError, DatabaseRequirements>(
  scope: Scope.Scope,
  options: LocalUserStoreOptions<DatabaseError, DatabaseRequirements>,
) =>
  Effect.gen(function* () {
    const sqlContext = yield* Layer.build(options.sql).pipe(Scope.provide(scope));
    const sql = Context.get(sqlContext, SqlClient.SqlClient);
    const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql);
    const infrastructure = Layer.mergeAll(sqlLayer, Platform.layerCrypto);

    yield* UserStore.migrate.pipe(Effect.provide(infrastructure));
    const storeContext = yield* Layer.build(
      UserStore.layer.pipe(Layer.provide(infrastructure)),
    ).pipe(Scope.provide(scope));
    const store = Context.get(storeContext, UserStore.UserStore);
    const profile = yield* store.ensureLocalProfile(options.profile);
    return { sqlLayer, store, profile };
  });

/** Creates or reuses the real local profile before its pool object is configured. */
export const initializeLocalUserProfile = <DatabaseError, DatabaseRequirements>(
  options: LocalUserStoreOptions<DatabaseError, DatabaseRequirements>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const { profile } = yield* openLocalUserStore(scope, options);
      return profile;
    }),
  );

/** Provisions one real local user domain around a caller-owned pool directory. */
export const createLocalUser = <DatabaseError, DatabaseRequirements, PoolError, PoolRequirements>(
  options: LocalUserOptions<DatabaseError, DatabaseRequirements, PoolError, PoolRequirements>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Scope.Scope);
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.orDie));
    const { sqlLayer, store, profile } = yield* openLocalUserStore(scope, options);
    const poolDirectory = yield* options.pools(profile.id);
    const poolActor = { userId: profile.id };

    const userDependencies = Layer.mergeAll(
      sqlLayer,
      Platform.layerCrypto,
      Layer.succeed(UserStore.UserStore, store),
      UserContexts.layerWithDrives.pipe(Layer.provide(sqlLayer)),
      ResourceBindings.layer.pipe(Layer.provide(sqlLayer)),
      OnePasswordAccount.layer.pipe(Layer.provide(sqlLayer)),
    );
    const folders = UserFolders.layer.pipe(Layer.provide(userDependencies));
    const userWithFolders = Layer.mergeAll(userDependencies, folders);
    const poolDirectoryLayer = Layer.succeed(PoolDirectory.PoolDirectory, poolDirectory);
    const pools = UserPools.layer.pipe(
      Layer.provide(Layer.mergeAll(userWithFolders, poolDirectoryLayer)),
    );
    const userWithPools = pools.pipe(
      Layer.provideMerge(Layer.mergeAll(userWithFolders, poolDirectoryLayer)),
    );
    const drives = UserDrives.layer.pipe(Layer.provide(userWithPools));
    const modelSettings = UserModelSettings.layer.pipe(Layer.provide(userWithPools));
    const catalog = ModelCatalog.layer.pipe(Layer.provide(ModelManifest.layerBundled));
    const threadContexts = ThreadContextLayers.layer.pipe(
      Layer.provide(Layer.mergeAll(userWithPools, drives, modelSettings, catalog)),
    );
    const domainContext = yield* Layer.build(
      Layer.mergeAll(userWithPools, drives, modelSettings, catalog, threadContexts),
    ).pipe(Scope.provide(scope));

    const actualUserContexts = Context.get(domainContext, UserContexts.UserContexts);
    const actualUserDrives = Context.get(domainContext, UserDrives.UserDrives);
    const actualUserFolders = Context.get(domainContext, UserFolders.UserFolders);
    const actualUserPools = Context.get(domainContext, UserPools.UserPools);
    const actualModelCatalog = Context.get(domainContext, ModelCatalog.ModelCatalog);
    const actualOnePassword = Context.get(domainContext, OnePasswordAccount.OnePasswordAccount);
    const actualThreadContexts = Context.get(domainContext, ThreadContexts.ThreadContexts);

    // UserPools.list is the product creation path for a user's Personal pool.
    yield* actualUserPools.list(poolActor);

    const http = FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, async () => {
          throw new Error("External user requests are disabled in a local domain.");
        }),
      ),
    );
    const github = GitHub.layer(null).pipe(Layer.provide(http));
    const githubContext = yield* Layer.build(
      GitHubConnection.layer.pipe(Layer.provide(Layer.mergeAll(sqlLayer, github))),
    ).pipe(Scope.provide(scope));
    const actualGitHubConnection = Context.get(githubContext, GitHubConnection.GitHubConnection);

    const directory = UserDirectory.local(profile.id, {
      profile: store.profile,
      githubCommitAuthor: actualGitHubConnection.commitAuthor,
      onePasswordToken: actualOnePassword.token,
      contextIds: actualUserContexts.contextIds,
      driveAccess: actualUserDrives.access,
      readableDrives: Effect.all({
        contexts: actualUserContexts.contexts,
        drives: actualUserDrives.drives,
      }),
    });

    const actualTurns = yield* Deferred.make<{
      readonly kinds: UserThreadKinds.UserThreadKinds["Service"];
      readonly turns: ThreadKindTurns.ThreadKindTurns["Service"];
    }>();
    const turnsBridge = ThreadKindTurns.ThreadKindTurns.of({
      beforeTurn: (threadId, message) =>
        Effect.flatMap(Deferred.await(actualTurns), ({ turns }) =>
          turns.beforeTurn(threadId, message),
        ),
    });
    let readyDirectory: ThreadDirectory.ThreadDirectory["Service"] | undefined;
    const ready = (threadDirectory: ThreadDirectory.ThreadDirectory["Service"]) =>
      Effect.suspend(() => {
        if (readyDirectory === threadDirectory) return Effect.void;
        if (readyDirectory !== undefined) {
          return Effect.die("A local user cannot be rebound to another thread directory.");
        }
        const archiveAlarm =
          options.chatArchiveAlarm ??
          LocalChatArchiveAlarm.layer(
            scope,
            Effect.flatMap(Deferred.await(actualTurns), ({ kinds }) => kinds.alarm),
          );
        const kinds = UserThreadKinds.layerTurns.pipe(
          Layer.provideMerge(UserThreadKinds.layer),
          Layer.provide(
            Layer.mergeAll(
              sqlLayer,
              Layer.succeed(UserContexts.UserContexts, actualUserContexts),
              Layer.succeed(ThreadDirectory.ThreadDirectory, threadDirectory),
              KindClassifier.layerFromEnv({}).pipe(Layer.provide(http)),
              archiveAlarm,
            ),
          ),
        );
        return Layer.build(kinds)
          .pipe(Scope.provide(scope))
          .pipe(
            Effect.flatMap((context) =>
              Deferred.succeed(actualTurns, {
                kinds: Context.get(context, UserThreadKinds.UserThreadKinds),
                turns: Context.get(context, ThreadKindTurns.ThreadKindTurns),
              }),
            ),
            Effect.tap(() => Effect.sync(() => (readyDirectory = threadDirectory))),
            Effect.asVoid,
          );
      });

    const actor = Effect.map(actualUserContexts.contextIds, (contextIds) => ({
      userId: profile.id,
      contextIds,
    }));
    const refreshPools = actualUserPools.refresh(poolActor).pipe(Effect.asVoid);
    const catalogView = Effect.gen(function* () {
      const pools = yield* actualUserPools.state(poolActor);
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* actualModelCatalog.view({ pools, checkedAt });
    });
    const home = actualUserFolders.snapshot;
    const recordSummary = (summary: ThreadSummary) =>
      Effect.flatMap(Deferred.await(actualTurns), ({ kinds }) =>
        kinds.recordSummary(summary, store.recordThreadSummary(summary)),
      );
    const alarm = Effect.flatMap(Deferred.await(actualTurns), ({ kinds }) => kinds.alarm);
    const platform = Layer.mergeAll(
      Layer.succeed(ThreadContexts.ThreadContexts, actualThreadContexts),
      Layer.succeed(UserDirectory.UserDirectory, directory),
      Layer.succeed(ThreadKindTurns.ThreadKindTurns, turnsBridge),
    );

    return {
      profile,
      actor,
      platform,
      ready,
      directory,
      refreshPools,
      catalog: catalogView,
      home,
      recordSummary,
      alarm,
    };
  });
