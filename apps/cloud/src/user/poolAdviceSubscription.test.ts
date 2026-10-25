import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

const actor = { userId: "advice-recovery" };
const currentAdvice = [
  {
    poolId: "personal",
    providers: [{ driver: "claudeAgent", historyHours: 0, addAccounts: 0 }],
  },
];

const setup = Effect.gen(function* () {
  const cloud = makeMemoryCloud();
  yield* cloud.userDirectory
    .forUser(actor.userId)
    .recordSignIn({ id: actor.userId, email: "a@b.c" });
  const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        CloudRpc.layerHandlers({
          identity: { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" },
          userId: actor.userId,
          sid: "test-session",
        }),
        CloudRpc.layerScopeAuthorization([AuthOrchestrationReadScope, AuthProvidersManageScope]),
      ).pipe(Layer.provide(cloud.layerFor(actor.userId))),
    ),
  );
  const name = `${actor.userId}:personal`;
  const personal = cloud.pools.objectFor(name);
  const pool = cloud.pools.directory.forPool(name);
  yield* pool.create(actor, { name: "Personal", personal: true });
  const login = yield* pool.startLogin(actor, "claude");
  yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
  const account = [...personal.cliProxyApi.accounts.values()][0]!;
  account.usage = {
    status: 200,
    body: JSON.stringify({ seven_day: { utilization: 25, resets_at: "2099-01-05T00:00:00.000Z" } }),
  };
  yield* pool.loginStatus(actor, login.state);
  expect(yield* pool.advice(actor)).toEqual(currentAdvice[0]!.providers);

  const failed = yield* Deferred.make<void>();
  cloud.pools.objects.set(name, {
    ...personal,
    api: {
      ...personal.api,
      create: (...args) =>
        Deferred.doneUnsafe(failed, Effect.void)
          ? Promise.reject(new Error("Pool object unavailable"))
          : personal.api.create(...args),
    },
  });
  const revoke = Effect.promise(() =>
    personal.runtime.runPromise(
      SqlClient.SqlClient.use((sql) => sql`DELETE FROM grants WHERE user_id = ${actor.userId}`),
    ),
  );
  return { rpc, failed, revoke };
});

describe("pool advice subscription recovery", () => {
  it.effect("recovers on the same connection and removes advice after access is revoked", () =>
    Effect.gen(function* () {
      const { rpc, failed, revoke } = yield* setup;
      const recovered = yield* Deferred.make<void>();
      const subscription = yield* rpc[WS_METHODS.accountPoolSubscribeAdvice]({}).pipe(
        Stream.tap(() => Deferred.succeed(recovered, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(failed);
      yield* TestClock.adjust("2 seconds");
      yield* Effect.raceFirst(Deferred.await(recovered), Fiber.join(subscription));
      yield* revoke;
      yield* rpc[WS_METHODS.serverRefreshProviders]({});
      expect(yield* Fiber.join(subscription)).toEqual([currentAdvice, []]);
    }).pipe(Effect.scoped),
  );
});
