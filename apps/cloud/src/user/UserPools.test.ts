import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { poolInstanceId } from "@t3tools/contracts/accountHub";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import * as UserPools from "./UserPools.ts";

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

  it.effect("bounds pool RPC snapshots when the pool object never answers and retries", () => {
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
            CloudRpc.layerHandlers({ identity, userId, sid: "pool-snapshot-deadline" }),
            CloudRpc.layerScopeAuthorization([
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
              AuthProvidersManageScope,
            ]),
          ).pipe(Layer.provide(cloud.layerFor(userId))),
        ),
      );

      yield* rpc[WS_METHODS.accountPoolSubscribe]({}).pipe(Stream.take(1), Stream.runDrain);
      const personal = cloud.pools.objectFor(`${userId}:personal`);
      const pool = cloud.pools.directory.forPool(`${userId}:personal`);
      const login = yield* pool.startLogin(actor, "claude");
      yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
      yield* pool.loginStatus(actor, login.state);
      yield* rpc[WS_METHODS.serverRefreshProviders]({});

      // Simulate the real Durable Object RPC Promise never producing a response.
      const originalAccounts = personal.api.accounts;
      const pendingReads: Array<() => void> = [];
      let accountCalls = 0;
      let lastAccountReply: unknown;
      let blocked = true;
      let signalStart!: () => void;
      let started = new Promise<void>((resolve) => {
        signalStart = resolve;
      });
      let didSignalStart = false;
      cloud.pools.objects.set(`${userId}:personal`, {
        ...personal,
        api: {
          ...personal.api,
          accounts: (reader) => {
            accountCalls += 1;
            if (!blocked) {
              const reply = originalAccounts(reader);
              void reply.then((value) => {
                lastAccountReply = value;
              });
              return reply;
            }
            if (!didSignalStart) {
              didSignalStart = true;
              signalStart();
            }
            return new Promise((resolve, reject) => {
              pendingReads.push(() => {
                void originalAccounts(reader).then(resolve, reject);
              });
            });
          },
        },
      });

      const startedSnapshotAt = startedAt + 30_001;
      const deadlineMs = UserPools.POOL_SNAPSHOT_TIMEOUT_MS;
      const timed = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.flatMap((value) =>
            Effect.map(Clock.currentTimeMillis, (completedAt) => ({ value, completedAt })),
          ),
        );
      const poolList = rpc[WS_METHODS.accountPoolSubscribe]({}).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      const configStream = rpc[WS_METHODS.subscribeServerConfig]({ usageLimitSources: true }).pipe(
        Stream.take(2),
        Stream.runCollect,
      );
      const getConfig = rpc[WS_METHODS.serverGetConfig]({});

      // UserPools' own snapshot is stale, so all three real RPC paths hit the blocked object.
      vi.setSystemTime(startedSnapshotAt);
      yield* TestClock.adjust(30_001);
      const requests = yield* Effect.forkChild(
        Effect.all([timed(poolList), timed(configStream), timed(getConfig)], {
          concurrency: "unbounded",
        }).pipe(
          Effect.timeoutOrElse({
            duration: deadlineMs + 500,
            orElse: () => Effect.succeed(null),
          }),
        ),
      );
      yield* Effect.promise(() => started);
      vi.setSystemTime(startedSnapshotAt + deadlineMs + 501);
      yield* TestClock.adjust(deadlineMs + 501);
      const result = yield* Fiber.join(requests);

      // Let the real object calls finish after asserting the client-facing deadline.
      blocked = false;
      for (const release of pendingReads) release();
      if (result === null) {
        expect(result).not.toBeNull();
        return;
      }

      const [poolsRead, eventsRead, configRead] = result;
      expect(poolsRead.completedAt - startedSnapshotAt).toBeLessThanOrEqual(deadlineMs);
      expect(eventsRead.completedAt - startedSnapshotAt).toBeLessThanOrEqual(deadlineMs);
      expect(configRead.completedAt - startedSnapshotAt).toBeLessThanOrEqual(deadlineMs);
      const pools = poolsRead.value;
      const events = eventsRead.value;
      const config = configRead.value;
      expect(pools[0]?.map((entry) => entry.name)).toEqual(["Personal"]);
      const snapshot = events[0];
      const sources = events[1];
      expect(snapshot?.type).toBe("snapshot");
      expect(sources?.type).toBe("usageLimitSourcesUpdated");
      if (snapshot?.type !== "snapshot" || sources?.type !== "usageLimitSourcesUpdated") {
        throw new Error("Expected a config snapshot and its usage sources");
      }
      const source = sources.payload.sources.find((entry) => entry.label === "Personal");
      expect(source?.accounts).toEqual([]);
      expect(source?.error).toBeTruthy();
      expect(config.settings.providerInstances).toHaveProperty(
        poolInstanceId("claude", "personal"),
      );

      // A live config subscription retries on its ordinary pool refresh interval.
      const recovered = yield* Deferred.make<void>();
      const recoverySnapshot = yield* Deferred.make<void>();
      let lastRecoverySource: unknown;
      const recoveryStream = rpc[WS_METHODS.subscribeServerConfig]({
        usageLimitSources: true,
      }).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "snapshot") yield* Deferred.succeed(recoverySnapshot, undefined);
            if (event.type === "usageLimitSourcesUpdated") {
              lastRecoverySource = event.payload.sources.find(
                (entry) => entry.label === "Personal",
              );
            }
            if (
              event.type === "usageLimitSourcesUpdated" &&
              event.payload.sources.some(
                (entry) => entry.label === "Personal" && entry.accounts.length > 0 && !entry.error,
              )
            ) {
              yield* Deferred.succeed(recovered, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* recoveryStream;
      yield* Deferred.await(recoverySnapshot);
      const callsBeforePolling = accountCalls;
      const pollingAt = (yield* Clock.currentTimeMillis) + 30_001;
      vi.setSystemTime(pollingAt);
      yield* TestClock.adjust(30_001);
      expect(accountCalls).toBeGreaterThan(callsBeforePolling);
      const recoveryCheck = yield* Effect.forkChild(
        Deferred.await(recovered).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({ duration: 1_000, orElse: () => Effect.succeed(false) }),
        ),
      );
      const recoveryDeadlineAt = (yield* Clock.currentTimeMillis) + 1_000;
      vi.setSystemTime(recoveryDeadlineAt);
      yield* TestClock.adjust(1_000);
      const didRecover = yield* Fiber.join(recoveryCheck);
      if (!didRecover) {
        expect(lastAccountReply).toMatchObject({
          _tag: "ok",
          value: {
            accounts: expect.arrayContaining([
              expect.objectContaining({ email: "claude-1@example.test" }),
            ]),
          },
        });
        expect(lastRecoverySource).toMatchObject({ error: undefined });
      }
      expect(didRecover).toBe(true);
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.useRealTimers())));
  });

  it.effect("keeps a healthy pool's accounts across concurrent reads with a stalled pool", () => {
    const cloud = makeMemoryCloud();
    return Effect.gen(function* () {
      const pools = yield* UserPools.UserPools;
      yield* pools.state(actor);
      const personal = cloud.pools.directory.forPool(`${userId}:personal`);
      const login = yield* personal.startLogin(actor, "claude");
      yield* personal.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
      yield* personal.loginStatus(actor, login.state);
      const slow = yield* pools.create(actor, { name: "Slow" });
      const healthyAccounts = (yield* pools.state(actor)).find((entry) => entry.pool.personal)
        ?.source.accounts;
      expect(healthyAccounts).toHaveLength(1);
      const slowPool = (yield* pools.list(actor)).find((pool) => pool.id === slow.id);
      if (slowPool === undefined) throw new Error("Expected the slow pool to exist");
      const slowObject = cloud.pools.objectFor(slowPool.objectName);
      const originalAccounts = slowObject.api.accounts;
      const pending: Array<() => void> = [];
      const { promise: started, resolve: signalStart } = Promise.withResolvers<void>();
      cloud.pools.objects.set(slowPool.objectName, {
        ...slowObject,
        api: {
          ...slowObject.api,
          accounts: (reader) => {
            signalStart();
            return new Promise((resolve, reject) => {
              pending.push(() => void originalAccounts(reader).then(resolve, reject));
            });
          },
        },
      });

      yield* TestClock.adjust(PoolEngine.ACCOUNTS_FRESH_MS + 1);
      const reads = yield* Effect.forkChild(
        Effect.all([pools.state(actor), pools.state(actor), pools.state(actor)], {
          concurrency: "unbounded",
        }),
      );
      yield* Effect.promise(() => started);
      yield* TestClock.adjust(UserPools.POOL_SNAPSHOT_TIMEOUT_MS + 1);
      const states = yield* Fiber.join(reads);
      for (const state of states) {
        const healthy = state.find((entry) => entry.pool.personal);
        expect(healthy?.source.accounts).toEqual(healthyAccounts);
        expect(healthy?.source.error).toBeUndefined();
        expect(state.find((entry) => entry.pool.id === slow.id)?.source.error).toBeTruthy();
      }
      expect(pending).toHaveLength(1);
      for (const release of pending) release();
    }).pipe(Effect.provide(cloud.userObject(userId)), Effect.scoped);
  });
});
