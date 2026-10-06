import {
  WORKOS_TEST_ENV,
  type WorkOSCodes,
  workosStubLayer,
} from "@signalbox/account/WorkOSTesting";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as CloudAccounts from "./account/CloudAccounts.ts";
import * as CloudSessions from "./auth/CloudSessions.ts";
import * as CloudTokens from "./auth/CloudTokens.ts";
import * as CloudConfig from "./CloudConfig.ts";
import * as Platform from "./platform.ts";
import * as UserDirectory from "./user/UserDirectory.ts";
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

/** A user store on a fresh in-memory database, migrated. */
export const layerMemoryStore = UserStore.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(UserStore.migrate)),
  Layer.provideMerge(
    Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), Platform.layerCrypto),
  ),
);

/** One in-memory user object per user id, running the same API the Durable Object does. */
const layerMemoryUsers = Layer.sync(UserDirectory.UserDirectory, () => {
  const objects = new Map<string, UserDirectory.UserObjectApi>();
  const objectFor = (userId: string) => {
    const existing = objects.get(userId);
    if (existing) return existing;
    const runtime = ManagedRuntime.make(layerMemoryStore);
    const api = makeUserObjectApi((effect) => runtime.runPromise(effect));
    objects.set(userId, api);
    return api;
  };
  return UserDirectory.UserDirectory.of({
    forUser: (userId) => UserDirectory.handleFor(objectFor(userId)),
    connect: () => Effect.die("Sockets are not part of these tests"),
  });
});

/** The sign-in stack with everything it uses exposed for assertions. */
export const layerAccounts = (codes: WorkOSCodes, env?: Readonly<Record<string, string>>) =>
  CloudAccounts.layer.pipe(
    Layer.provideMerge(CloudSessions.layer),
    Layer.provideMerge(CloudTokens.layer),
    Layer.provideMerge(layerConfig(env)),
    Layer.provideMerge(layerMemoryUsers),
    Layer.provideMerge(workosStubLayer(codes)),
  );
