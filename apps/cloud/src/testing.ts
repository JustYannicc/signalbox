import {
  WORKOS_TEST_ENV,
  type WorkOSCodes,
  type WorkOSMemberships,
  workosStubLayer,
} from "@signalbox/account/WorkOSTesting";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as CloudAccounts from "./account/CloudAccounts.ts";
import * as CloudSessions from "./auth/CloudSessions.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import * as CloudConfig from "./CloudConfig.ts";
import * as Platform from "./platform.ts";
import * as UserDirectory from "./user/UserDirectory.ts";
import * as UserContexts from "./user/UserContexts.ts";
import { makeUserObjectApi } from "./user/userObjectApi.ts";
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

/** A user object's services on a fresh in-memory database, migrated. */
export const layerMemoryStore = Layer.mergeAll(UserStore.layer, UserContexts.layer).pipe(
  Layer.provideMerge(Layer.effectDiscard(UserStore.migrate)),
  Layer.provideMerge(
    Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
  ),
);

/**
 * One in-memory user object per user id, running the same API the Durable
 * Object does. `run` reaches straight into an object's services for assertions;
 * any failure there is a test defect.
 */
export class MemoryUserObjects extends Context.Service<
  MemoryUserObjects,
  {
    readonly api: (userId: string) => UserDirectory.UserObjectApi;
    readonly run: <A, E>(
      userId: string,
      effect: Effect.Effect<A, E, Layer.Success<typeof layerMemoryStore>>,
    ) => Effect.Effect<A>;
  }
>()("@signalbox/cloud/testing/MemoryUserObjects") {}

const layerMemoryObjects = Layer.sync(MemoryUserObjects, () => {
  const runtimes = new Map<
    string,
    ManagedRuntime.ManagedRuntime<Layer.Success<typeof layerMemoryStore>, unknown>
  >();
  const runtimeFor = (userId: string) => {
    const existing = runtimes.get(userId);
    if (existing) return existing;
    const runtime = ManagedRuntime.make(layerMemoryStore);
    runtimes.set(userId, runtime);
    return runtime;
  };
  return MemoryUserObjects.of({
    api: (userId) => makeUserObjectApi((effect) => runtimeFor(userId).runPromise(effect)),
    run: (userId, effect) => Effect.promise(() => runtimeFor(userId).runPromise(effect)),
  });
});

const layerMemoryUsers = Layer.effect(
  UserDirectory.UserDirectory,
  Effect.gen(function* () {
    const objects = yield* MemoryUserObjects;
    return UserDirectory.UserDirectory.of({
      forUser: (userId) => UserDirectory.handleFor(objects.api(userId)),
      connect: () => Effect.die("Sockets are not part of these tests"),
    });
  }),
).pipe(Layer.provideMerge(layerMemoryObjects));

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
