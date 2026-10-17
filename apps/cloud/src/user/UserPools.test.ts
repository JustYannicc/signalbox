import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcTest from "effect/rpc/RpcTest";
import { vi } from "vite-plus/test";

import * as PoolEngine from "../pool/PoolEngine.ts";
import * as PoolContainer from "../pool/PoolContainer.ts";
import { makeMemoryCloud } from "../testing.ts";
import * as CloudRpc from "./rpc.ts";

const userId = "pool-config-subscription";
const actor = { userId };
const identity = {
  environmentId: EnvironmentId.make("cloud-test"),
  label: "Cloud",
};

describe("UserPools config subscriptions", () => {
  it.effect("sends models refreshed by a pool alarm to an already open config stream", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-17T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    return Effect.gen(function* () {
      yield* TestClock.setTime(startedAt);
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({ id: userId, email: "a@b.c" });
      const rpc = yield* RpcTest.makeClient(CloudRpc.CloudRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            CloudRpc.layerHandlers({ identity, userId, sid: "pool-config-subscription" }),
            CloudRpc.layerScopeAuthorization([
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
              AuthProvidersManageScope,
            ]),
          ).pipe(Layer.provide(cloud.layerFor(userId))),
        ),
      );

      // Create Personal and seed the user's cached provider list.
      yield* rpc[WS_METHODS.accountPoolSubscribe]({}).pipe(Stream.take(1), Stream.runDrain);
      const personal = cloud.pools.objectFor(`${userId}:personal`);
      const pool = cloud.pools.directory.forPool(`${userId}:personal`);
      const login = yield* pool.startLogin(actor, "claude");
      yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
      yield* pool.loginStatus(actor, login.state);
      yield* rpc[WS_METHODS.serverRefreshProviders]({});

      const snapshotReady = yield* Deferred.make<void>();
      const modelArrived = yield* Deferred.make<void>();
      const providerUpdates = yield* Ref.make(0);
      const subscription = rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "providerStatuses")
              yield* Ref.update(providerUpdates, (count) => count + 1);
            if (event.type === "snapshot") return yield* Deferred.succeed(snapshotReady, undefined);
            if (
              event.type === "providerStatuses" &&
              event.payload.providers.some((provider) =>
                provider.models.some((model) => model.slug === "claude-alarm-refreshed-model"),
              )
            ) {
              return yield* Deferred.succeed(modelArrived, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* subscription;
      yield* Deferred.await(snapshotReady);

      yield* Effect.promise(() =>
        personal.runtime.runPromise(PoolContainer.PoolContainer.use((container) => container.stop)),
      );

      personal.cliProxyApi.catalog.claude!.push({
        id: "claude-alarm-refreshed-model",
        created: 1,
        displayName: "Alarm refreshed model",
        reasoningEfforts: [],
      });
      vi.setSystemTime(startedAt + PoolEngine.MODELS_REFRESH_MS + 1);
      yield* TestClock.adjust(PoolEngine.MODELS_REFRESH_MS + 1);
      expect(yield* Deferred.isDone(modelArrived)).toBe(false);
      expect(yield* Ref.get(providerUpdates)).toBe(0);

      // Only the alarm wakes the pool and updates its catalog; the user stream must reread it.
      yield* Effect.promise(() =>
        personal.runtime.runPromise(
          PoolEngine.PoolEngine.use((engine) => engine.refreshModelsAtAlarm()),
        ),
      );
      vi.setSystemTime(startedAt + PoolEngine.MODELS_REFRESH_MS + PoolEngine.ACCOUNTS_FRESH_MS + 2);
      yield* TestClock.adjust(PoolEngine.ACCOUNTS_FRESH_MS + 1);

      yield* Deferred.await(modelArrived);
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  });
});
