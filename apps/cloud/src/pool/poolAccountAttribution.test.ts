import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PoolEngine from "./PoolEngine.ts";
import { SAMPLE_EVERY_MS } from "./poolUsageHistory.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "alice" };
const bob = { userId: "bob" };
const START = Date.parse("2026-10-05T08:00:00.000Z");

const setup = Effect.gen(function* () {
  const object = makeMemoryPoolObject();
  object.cliProxyApi.accounts.set("existing.json", {
    type: "claude",
    email: "existing@example.test",
    disabled: false,
  });
  const engine = yield* Effect.promise(() => object.runtime.runPromise(PoolEngine.PoolEngine));
  yield* engine.initialize;
  yield* TestClock.setTime(START);
  yield* engine.create(alice, { name: "Work", personal: false });
  const login = yield* engine.startLogin(alice, "claude");
  const sql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.promise(() => object.runtime.runPromise(effect));
  const attribution = (name: string) =>
    sql(
      SqlClient.SqlClient.use(
        (sql) => sql`SELECT contributed_by, added_at FROM accounts WHERE name = ${name}`,
      ),
    );
  return { object, engine, login, sql, attribution };
});

describe("account contributor attribution", () => {
  it.effect("leaves login discovery to the authoritative refresh, preserving existing owners", () =>
    Effect.gen(function* () {
      const { object, engine, login, sql, attribution } = yield* setup;
      expect(yield* engine.nextUsageSampleAt()).toBe(START + SAMPLE_EVERY_MS);
      yield* sql(
        SqlClient.SqlClient.use(
          (sql) => sql`INSERT INTO grants (user_id, role, granted_at) VALUES ('bob', 'admin', 0)`,
        ),
      );
      const otherLogin = yield* engine.startLogin(bob, "claude");
      yield* engine.completeLogin(
        alice,
        `http://localhost:54545/callback?code=c&state=${login.state}`,
      );
      const name = [...object.cliProxyApi.accounts.keys()].find(
        (name) => name !== "existing.json",
      )!;
      const cachedAt = START + SAMPLE_EVERY_MS;
      yield* TestClock.setTime(cachedAt);
      expect(yield* engine.nextUsageSampleAt()).toBe(cachedAt);
      yield* engine.refreshUsageAtAlarm();
      expect(yield* attribution(name)).toEqual([]);
      expect(object.cliProxyApi.accountRequests.map((request) => request.name)).toContain(name);

      yield* TestClock.setTime(cachedAt + 1);
      // Polling as another admin still credits the person who started the login.
      expect(yield* engine.loginStatus(bob, login.state)).toEqual({ status: "ok" });
      expect(yield* attribution(name)).toEqual([
        { contributed_by: "alice", added_at: cachedAt + 1 },
      ]);

      yield* engine.completeLogin(
        bob,
        `http://localhost:54545/callback?code=c&state=${otherLogin.state}`,
      );
      object.cliProxyApi.accounts.set(name, {
        ...object.cliProxyApi.accounts.get(name)!,
        email: "updated@example.test",
      });
      expect(yield* engine.loginStatus(bob, otherLogin.state)).toEqual({ status: "ok" });
      // Bob's earlier snapshot also missed Alice's account, but cannot take its ownership.
      expect(yield* attribution(name)).toEqual([
        { contributed_by: "alice", added_at: cachedAt + 1 },
      ]);
      const otherName = [...object.cliProxyApi.accounts.keys()].find(
        (candidate) => candidate !== "existing.json" && candidate !== name,
      )!;
      expect(yield* attribution(otherName)).toEqual([
        { contributed_by: "bob", added_at: cachedAt + 1 },
      ]);
      expect(yield* attribution("existing.json")).toEqual([
        { contributed_by: null, added_at: START },
      ]);
    }),
  );

  it.effect("leaves import discovery to the authoritative refresh after the upload completes", () =>
    Effect.gen(function* () {
      const { object, engine, attribution } = yield* setup;
      expect(yield* engine.nextUsageSampleAt()).toBe(START + SAMPLE_EVERY_MS);
      const uploaded = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const serve = object.cliProxyApi.serve;
      object.cliProxyApi.serve = async (request) => {
        const response = await serve(request);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/credentials")) {
          uploaded.resolve();
          await release.promise;
        }
        return response;
      };
      yield* Effect.gen(function* () {
        const importing = yield* Effect.forkChild(
          engine.importAccounts(alice, [
            {
              name: "imported.json",
              content: JSON.stringify({ type: "claude", email: "import@example.test" }),
            },
          ]),
        );
        yield* Effect.promise(() => uploaded.promise);
        const cachedAt = START + SAMPLE_EVERY_MS;
        yield* TestClock.setTime(cachedAt);
        expect(yield* engine.nextUsageSampleAt()).toBe(cachedAt);
        yield* engine.refreshUsageAtAlarm();
        expect(yield* attribution("imported.json")).toEqual([]);
        expect(object.cliProxyApi.accountRequests.map((request) => request.name)).toContain(
          "imported.json",
        );
        yield* TestClock.setTime(cachedAt + 1);
        release.resolve();
        expect(yield* Fiber.join(importing)).toEqual({ imported: ["imported.json"], skipped: [] });
        expect(yield* attribution("imported.json")).toEqual([
          { contributed_by: "alice", added_at: cachedAt + 1 },
        ]);
        expect(yield* attribution("existing.json")).toEqual([
          { contributed_by: null, added_at: START },
        ]);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
    }),
  );

  it.effect.each([false, true])(
    "preserves the original Bob-first overlapping-login heuristic with alarm=%s",
    (alarm) =>
      Effect.gen(function* () {
        const { object, engine, login, sql, attribution } = yield* setup;
        if (alarm) expect(yield* engine.nextUsageSampleAt()).toBe(START + SAMPLE_EVERY_MS);
        yield* sql(
          SqlClient.SqlClient.use(
            (sql) => sql`INSERT INTO grants (user_id, role, granted_at) VALUES ('bob', 'admin', 0)`,
          ),
        );
        const otherLogin = yield* engine.startLogin(bob, "claude");
        for (const state of [login.state, otherLogin.state])
          yield* engine.completeLogin(
            alice,
            `http://localhost:54545/callback?code=c&state=${state}`,
          );
        const added = [...object.cliProxyApi.accounts.keys()].filter(
          (name) => name !== "existing.json",
        );
        expect(added).toHaveLength(2);
        yield* TestClock.setTime(START + SAMPLE_EVERY_MS);
        if (alarm) {
          expect(yield* engine.nextUsageSampleAt()).toBe(START + SAMPLE_EVERY_MS);
          yield* engine.refreshUsageAtAlarm();
        }
        for (const name of added) expect(yield* attribution(name)).toEqual([]);
        const insertedAt = START + SAMPLE_EVERY_MS + 1;
        yield* TestClock.setTime(insertedAt);
        expect(yield* engine.loginStatus(bob, otherLogin.state)).toEqual({ status: "ok" });
        yield* TestClock.setTime(insertedAt + 1);
        expect(yield* engine.loginStatus(alice, login.state)).toEqual({ status: "ok" });
        // The original known-name heuristic credits both to the first completed status refresh.
        for (const name of added)
          expect(yield* attribution(name)).toEqual([
            { contributed_by: "bob", added_at: insertedAt },
          ]);
        expect(yield* attribution("existing.json")).toEqual([
          { contributed_by: null, added_at: START },
        ]);
      }),
  );
});
