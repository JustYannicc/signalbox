import {
  WORKOS_TEST_ENV,
  type WorkOSCodes,
  type WorkOSMemberships,
  workosStubLayer,
} from "@signalbox/account/WorkOSTesting";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as CloudAccounts from "./account/CloudAccounts.ts";
import * as CloudSessions from "./auth/CloudSessions.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import * as CloudConfig from "./CloudConfig.ts";
import * as Platform from "./platform.ts";
import * as CloudThreadService from "./thread/CloudThreadService.ts";
import { deliverPendingSummary } from "./thread/summaryOutbox.ts";
import * as ThreadDirectory from "./thread/ThreadDirectory.ts";
import * as ThreadEngine from "./thread/ThreadEngine.ts";
import { makeThreadObjectApi } from "./thread/threadObjectApi.ts";
import * as MachineBackends from "./thread/runner/machineBackends.ts";
import type * as MachineBackend from "./thread/runner/MachineBackend.ts";
import * as ThreadRunner from "./thread/runner/ThreadRunner.ts";
import * as ThreadStore from "./thread/ThreadStore.ts";
import { contextOfProject } from "./user/contextProjects.ts";
import * as ThreadContexts from "./user/threadContexts.ts";
import * as UserContexts from "./user/UserContexts.ts";
import type * as DriveDirectory from "./drive/DriveDirectory.ts";
import type * as DrivePacks from "./drive/DrivePacks.ts";
import * as GitHub from "./github/GitHub.ts";
import * as GitHubBranches from "./github/GitHubBranches.ts";
import * as GitHubConnection from "./github/GitHubConnection.ts";
import * as UserSections from "./user/UserSections.ts";
import * as UserDirectory from "./user/UserDirectory.ts";
import { makeUserObjectApi } from "./user/userObjectApi.ts";
import * as UserShell from "./user/UserShell.ts";
import * as UserStore from "./user/UserStore.ts";

/** Test wiring: fixed config, a fake WorkOS, and user objects on in-memory SQLite. */

export const CLOUD_TEST_ENV = {
  ...WORKOS_TEST_ENV,
  ENVIRONMENT_ID: "cloud-test",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
} as const;

/** Fresh per call: Effect shares a layer built once, which would pin the first env. */
export const layerConfig = (env: Readonly<Record<string, string>> = CLOUD_TEST_ENV) =>
  Layer.fresh(CloudConfig.layer).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

/** A user object's storage services on a fresh in-memory database, migrated. */
export const layerMemoryStore = UserSections.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(UserStore.layer, UserContexts.layer)),
  Layer.provideMerge(Layer.effectDiscard(UserStore.migrate)),
  Layer.provideMerge(
    Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
  ),
);

/** Resolves contexts for a user who has only Personal, with no storage behind it. */
export const layerPersonalThreadContexts = Layer.succeed(
  ThreadContexts.ThreadContexts,
  ThreadContexts.ThreadContexts.of({
    placementOf: (projectId) =>
      Effect.succeed({
        contextId: contextOfProject([UserContexts.PERSONAL_CONTEXT], projectId),
        worktree: null,
      }),
  }),
);

/**
 * One thread object's engine on SQLite at `filename`. Building the layer again
 * on the same file is what a Durable Object waking after eviction does.
 */
export const layerThreadObject = (
  filename: string,
  machines: Layer.Layer<MachineBackend.MachineBackend> = MachineBackends.layerNone,
  options: { readonly drives?: boolean } = {},
) =>
  ThreadRunner.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(ThreadRunner.ThreadDrives, { enabled: options.drives === true }),
    ),
    Layer.provideMerge(ThreadEngine.layer),
    Layer.provideMerge(machines),
    Layer.provideMerge(ThreadStore.layer),
    Layer.provideMerge(Layer.mergeAll(NodeSqliteClient.layer({ filename }), Platform.layerCrypto)),
  );

/** GitHub with no App and no network, for tests that never reach it. */
const layerNoGitHub = GitHub.layer(null).pipe(Layer.provide(FetchHttpClient.layer));

const makeUserRuntime = (
  threads: ThreadDirectory.ThreadDirectory["Service"],
  github: Layer.Layer<GitHub.GitHub>,
  drives: Layer.Layer<DriveDirectory.DriveDirectory | DrivePacks.DrivePacks> | null,
) =>
  ManagedRuntime.make(
    Layer.mergeAll(UserShell.layer, GitHubConnection.layer).pipe(
      Layer.provideMerge(layerMemoryStore),
      Layer.provideMerge(github),
      Layer.provideMerge(drives ?? Layer.empty),
      Layer.provideMerge(Layer.succeed(ThreadDirectory.ThreadDirectory, threads)),
    ),
  );

/**
 * The cloud's objects in memory: a user object per user id and a thread
 * object per thread id, running the same APIs the Durable Objects do and
 * reaching each other through the same directories. `settle` does what the
 * thread objects' alarms do: drive every turn to the end and deliver every
 * pending summary.
 */
export const makeMemoryCloud = (
  options: {
    readonly github?: Layer.Layer<GitHub.GitHub>;
    /** Drives the user objects store into, as `makeMemoryDrives` makes them. */
    readonly drives?: Layer.Layer<DriveDirectory.DriveDirectory | DrivePacks.DrivePacks>;
  } = {},
) => {
  const users = new Map<
    string,
    {
      readonly api: UserDirectory.UserObjectApi;
      readonly runtime: ReturnType<typeof makeUserRuntime>;
    }
  >();
  const threads = new Map<
    string,
    {
      readonly api: ThreadDirectory.ThreadObjectApi;
      readonly run: <A, E>(
        effect: Effect.Effect<
          A,
          E,
          ThreadEngine.ThreadEngine | ThreadStore.ThreadStore | UserDirectory.UserDirectory
        >,
      ) => Promise<A>;
    }
  >();
  const userDirectory: UserDirectory.UserDirectory["Service"] = {
    forUser: (userId) => UserDirectory.handleFor(userFor(userId).api),
    connect: () => Effect.die("Sockets are not part of these tests"),
  };
  const threadDirectory: ThreadDirectory.ThreadDirectory["Service"] = {
    forThread: (threadId) => ThreadDirectory.handleFor(threadFor(threadId).api),
  };
  const userFor = (userId: string) => {
    const existing = users.get(userId);
    if (existing) return existing;
    const runtime = makeUserRuntime(
      threadDirectory,
      options.github ?? layerNoGitHub,
      options.drives ?? null,
    );
    const object = { api: makeUserObjectApi((effect) => runtime.runPromise(effect)), runtime };
    users.set(userId, object);
    return object;
  };
  const threadFor = (threadId: string) => {
    const existing = threads.get(threadId);
    if (existing) return existing;
    const runtime = ManagedRuntime.make(
      layerThreadObject(":memory:").pipe(
        Layer.provideMerge(Layer.succeed(UserDirectory.UserDirectory, userDirectory)),
      ),
    );
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        ThreadEngine.ThreadEngine | ThreadStore.ThreadStore | UserDirectory.UserDirectory
      >,
    ) => runtime.runPromise(effect);
    const object = { api: makeThreadObjectApi(run, async () => {}), run };
    threads.set(threadId, object);
    return object;
  };
  const userObject = (userId: string) =>
    Layer.effectContext(Effect.orDie(userFor(userId).runtime.contextEffect));
  const threadService = CloudThreadService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(UserDirectory.UserDirectory, userDirectory),
        Layer.succeed(ThreadDirectory.ThreadDirectory, threadDirectory),
      ),
    ),
    Layer.provideMerge(Platform.layerCrypto),
  );
  const settle = Effect.promise(async () => {
    for (const { run } of threads.values()) {
      await run(
        Effect.gen(function* () {
          const engine = yield* ThreadEngine.ThreadEngine;
          while (yield* engine.step) {
            // One provider step per alarm in production; here, until the turn ends.
          }
          yield* deliverPendingSummary;
        }),
      );
    }
  });
  return {
    userDirectory,
    threadDirectory,
    settle,
    /** The services inside `userId`'s object, for handlers that run there (the socket's RPC). */
    userObject,
    /** The thread service as `userId`'s object runs it, with that user's contexts. */
    layerFor: (userId: string) =>
      GitHubBranches.layer.pipe(
        Layer.provideMerge(threadService),
        Layer.provideMerge(ThreadContexts.layer),
        Layer.provideMerge(userObject(userId)),
      ),
    /** The thread service for tests where the user has only Personal. */
    layer: threadService.pipe(Layer.provideMerge(layerPersonalThreadContexts)),
  };
};

const layerMemoryUsers = Layer.sync(
  UserDirectory.UserDirectory,
  () => makeMemoryCloud().userDirectory,
);

/** The sign-in stack with everything it uses exposed for assertions. */
export const layerAccounts = (
  codes: WorkOSCodes,
  env?: Readonly<Record<string, string>>,
  memberships?: WorkOSMemberships,
) =>
  CloudAccounts.layer.pipe(
    Layer.provideMerge(CloudSessions.layer),
    Layer.provideMerge(CloudTokens.layer),
    Layer.provideMerge(layerConfig(env)),
    Layer.provideMerge(layerMemoryUsers),
    Layer.provideMerge(workosStubLayer(codes, [], memberships)),
  );
