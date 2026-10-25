import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { makeMemoryCloud } from "../testing.ts";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import { ACCOUNTS_READ_TIMEOUT_MESSAGE } from "../pool/PoolEngine.ts";
import * as UserPools from "./UserPools.ts";

const actor = { userId: "cold-pool-startup" };

describe("cold pool startup", () => {
  it.effect("retries the cold timeout on an open stream and publishes its first catalog", () => {
    const cloud = makeMemoryCloud();
    return Effect.gen(function* () {
      const pools = yield* UserPools.UserPools;
      yield* pools.list(actor);
      const objectName = `${actor.userId}:personal`;
      const personal = cloud.pools.objectFor(objectName);
      const pool = cloud.pools.directory.forPool(objectName);
      const login = yield* pool.startLogin(actor, "claude");
      yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
      yield* pool.loginStatus(actor, login.state);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT value FROM pool_snapshots`).toEqual([]);

      const started = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const empty = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const catalog = yield* ModelCatalog.ModelCatalog;
      const { promise: ready, resolve: release } = Promise.withResolvers<void>();
      cloud.pools.objects.set(objectName, {
        ...personal,
        api: {
          ...personal.api,
          accounts: async (reader) => {
            started.resolve();
            await ready;
            const reply = await personal.api.accounts(reader);
            finished.resolve();
            return reply;
          },
        },
      });
      yield* pools.changes(actor).pipe(
        Stream.runForEach((state) =>
          Effect.gen(function* () {
            const view = yield* catalog.view({ pools: state, checkedAt: "1970-01-01T00:00:00Z" });
            const claude = view.providers.find((provider) => provider.instanceId === "claude_hub");
            if (
              state[0]?.source.error ===
              "This pool is taking too long to respond. Try again shortly."
            ) {
              expect(claude?.models).toEqual([]);
              yield* Deferred.succeed(empty, undefined);
            }
            if ((claude?.models.length ?? 0) > 0) yield* Deferred.succeed(recovered, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust(UserPools.POOL_SNAPSHOT_TIMEOUT_MS);
      yield* Deferred.await(empty);
      const timedOut = yield* pools.state(actor);
      expect(timedOut[0]?.source.error).toBe(
        "This pool is taking too long to respond. Try again shortly.",
      );
      expect(timedOut[0]?.models).toEqual([]);

      release();
      yield* Effect.promise(() => finished.promise);
      yield* TestClock.adjust(1_000);
      expect(yield* Deferred.isDone(recovered)).toBe(true);
    }).pipe(Effect.provide(cloud.userObject(actor.userId)), Effect.scoped);
  });

  it.effect(
    "backs off repeated cold timeouts and resets the deadline after a successful retry",
    () => {
      const cloud = makeMemoryCloud();
      return Effect.gen(function* () {
        const pools = yield* UserPools.UserPools;
        yield* pools.list(actor);
        const objectName = `${actor.userId}:personal`;
        const personal = cloud.pools.objectFor(objectName);
        let calls = 0;
        let blocked = true;
        let started = Promise.withResolvers<void>();
        cloud.pools.objects.set(objectName, {
          ...personal,
          api: {
            ...personal.api,
            accounts: (reader) => {
              calls += 1;
              started.resolve();
              return blocked ? new Promise(() => {}) : personal.api.accounts(reader);
            },
          },
        });

        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
          const before = calls;
          started = Promise.withResolvers<void>();
          const read = yield* Effect.forkChild(pools.state(actor));
          yield* Effect.promise(() => started.promise);
          yield* TestClock.adjust(UserPools.POOL_SNAPSHOT_TIMEOUT_MS);
          expect((yield* Fiber.join(read))[0]?.source.error).toBeTruthy();
          yield* TestClock.adjust(delay - 501);
          yield* pools.state(actor);
          expect(calls).toBe(before + 1);
          yield* TestClock.adjust(1);
        }

        blocked = false;
        const healthy = yield* pools.state(actor);
        expect(healthy[0]?.source.error).toBeUndefined();
        const afterRecovery = calls;
        yield* TestClock.adjust(29_999);
        yield* pools.state(actor);
        expect(calls).toBe(afterRecovery);
        yield* TestClock.adjust(1);
        yield* pools.state(actor);
        expect(calls).toBe(afterRecovery + 1);
      }).pipe(Effect.provide(cloud.userObject(actor.userId)), Effect.scoped);
    },
  );

  it.effect(
    "retries the pool's own cold snapshot deadline without retrying an access refusal",
    () => {
      const cloud = makeMemoryCloud();
      return Effect.gen(function* () {
        const pools = yield* UserPools.UserPools;
        yield* pools.list(actor);
        const objectName = `${actor.userId}:personal`;
        const personal = cloud.pools.objectFor(objectName);
        let calls = 0;
        cloud.pools.objects.set(objectName, {
          ...personal,
          api: {
            ...personal.api,
            accounts: async (reader) => {
              calls += 1;
              const reply = await personal.api.accounts(reader);
              return reply._tag !== "ok" || calls > 1
                ? { _tag: "rejected", reason: "Access revoked" }
                : {
                    ...reply,
                    value: { ...reply.value, models: [], error: ACCOUNTS_READ_TIMEOUT_MESSAGE },
                  };
            },
          },
        });
        expect((yield* pools.state(actor))[0]?.source.error).toBe(ACCOUNTS_READ_TIMEOUT_MESSAGE);
        yield* TestClock.adjust(999);
        yield* pools.state(actor);
        expect(calls).toBe(1);
        yield* TestClock.adjust(1);
        expect((yield* pools.state(actor))[0]?.source.error).toBe("Access revoked");
        yield* TestClock.adjust(1_000);
        yield* pools.state(actor);
        expect(calls).toBe(2);
      }).pipe(Effect.provide(cloud.userObject(actor.userId)), Effect.scoped);
    },
  );
});
