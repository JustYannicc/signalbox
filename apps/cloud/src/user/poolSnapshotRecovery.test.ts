import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { makeMemoryCloud } from "../testing.ts";
import { limitsSource } from "../pool/poolViews.ts";
import * as UserPools from "./UserPools.ts";

const actor = { userId: "snapshot-recovery" };

describe("pool snapshot recovery", () => {
  it.effect(
    "recovers models and resets after restart, a failed read and an explicit refresh timeout",
    () => {
      const cloud = makeMemoryCloud();
      return Effect.gen(function* () {
        const pools = yield* UserPools.UserPools;
        yield* pools.state(actor);
        const objectName = `${actor.userId}:personal`;
        const personal = cloud.pools.objectFor(objectName);
        const pool = cloud.pools.directory.forPool(objectName);
        const login = yield* pool.startLogin(actor, "claude");
        yield* pool.completeLogin(actor, `http://localhost/callback?code=c&state=${login.state}`);
        const account = [...personal.cliProxyApi.accounts.values()][0];
        if (account === undefined) throw new Error("Expected a signed-in account");
        account.usage = {
          status: 200,
          body: JSON.stringify({
            five_hour: { utilization: 100, resets_at: "2099-01-01T12:00:00.000Z" },
            seven_day: { utilization: 50, resets_at: "2099-01-05T00:00:00.000Z" },
          }),
        };
        yield* pool.loginStatus(actor, login.state);
        const known = (yield* pools.refresh(actor))[0];
        expect(known?.models.length).toBeGreaterThan(0);
        const sql = yield* SqlClient.SqlClient;
        const [stored] = yield* sql<{ readonly value: string }>`SELECT value FROM pool_snapshots`;
        expect(stored?.value).not.toContain("@example.test");
        expect(stored?.value).not.toContain('"accounts"');
        expect(stored?.value).not.toContain('"role"');
        expect(stored?.value).not.toContain('"routing"');

        const originalAccounts = personal.api.accounts;
        const restarted = yield* UserPools.UserPools.pipe(
          Effect.provide(Layer.fresh(UserPools.layer)),
        );
        cloud.pools.objects.set(objectName, {
          ...personal,
          api: {
            ...personal.api,
            accounts: async () => {
              throw new Error("Temporary pool outage");
            },
          },
        });
        const [failed] = yield* restarted.state(actor);
        expect(failed?.source.error).toBeTruthy();
        expect(failed?.models).toEqual([]);

        const { promise: started, resolve: signalStart } = Promise.withResolvers<void>();
        const pending: Array<() => void> = [];
        cloud.pools.objects.set(objectName, {
          ...personal,
          api: {
            ...personal.api,
            accounts: (reader) => {
              signalStart();
              return new Promise((resolve, reject) => {
                pending.push(() => void originalAccounts(reader).then(resolve, reject));
              });
            },
          },
        });

        const read = yield* Effect.forkChild(restarted.refresh(actor));
        yield* Effect.promise(() => started);
        yield* TestClock.adjust(UserPools.POOL_SNAPSHOT_TIMEOUT_MS);
        const [snapshot] = yield* Fiber.join(read);
        for (const release of pending) release();
        expect(snapshot?.models).toEqual(known?.models);
        expect(snapshot?.source.accounts).toEqual([]);
        expect(snapshot?.source.error).toContain("last known");
        expect(snapshot?.role).toBeNull();
        expect(snapshot?.routing).toBeNull();
        if (snapshot === undefined) throw new Error("Expected a cached pool snapshot");
        expect(limitsSource(snapshot).accounts).toEqual([]);
        expect(snapshot.lastKnownOverview?.error).toContain("last known");
        expect(snapshot.lastKnownOverview?.providers[0]?.usage).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ nextResetAt: "2099-01-01T12:00:00.000Z" }),
          ]),
        );

        cloud.pools.objects.set(objectName, {
          ...personal,
          api: {
            ...personal.api,
            accounts: async () => ({ _tag: "rejected", reason: "Access revoked" }),
          },
        });
        const [rejected] = yield* restarted.refresh(actor);
        expect(rejected?.models).toEqual([]);
        expect(rejected?.source.error).toBe("Access revoked");
        expect(yield* sql`SELECT value FROM pool_snapshots`).toEqual([]);
      }).pipe(Effect.provide(cloud.userObject(actor.userId)), Effect.scoped);
    },
  );

  it.effect("does not fail a live snapshot when its optional cache cannot be written", () => {
    const cloud = makeMemoryCloud();
    return Effect.gen(function* () {
      const pools = yield* UserPools.UserPools;
      yield* pools.state(actor);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE pool_snapshots`;
      const [snapshot] = yield* pools.refresh(actor);
      expect(snapshot?.pool.id).toBe("personal");
      expect(snapshot?.source.error).toBeUndefined();
      const objectName = `${actor.userId}:personal`;
      const personal = cloud.pools.objectFor(objectName);
      cloud.pools.objects.set(objectName, {
        ...personal,
        api: {
          ...personal.api,
          accounts: async () => ({ _tag: "rejected", reason: "Access revoked" }),
        },
      });
      const [rejected] = yield* pools.refresh(actor);
      expect(rejected?.models).toEqual([]);
      expect(rejected?.source.error).toBe("Access revoked");
    }).pipe(Effect.provide(cloud.userObject(actor.userId)), Effect.scoped);
  });
});
