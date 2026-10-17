import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PoolEngine from "./PoolEngine.ts";
import { limitsSource, overview, usageSource } from "./poolViews.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";
import { HOUR_MS } from "@t3tools/shared/poolUsageRecording";

const alice = { userId: "alice" };
const bob = { userId: "bob" };
const outsider = { userId: "outsider" };
const START = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

describe("pool advice", () => {
  it.effect("records the full 2% to 50% rise across pause and resume", () =>
    Effect.gen(function* () {
      const backend = makeFakeCliProxyApi();
      const fake = {
        type: "claude",
        email: "private@example.test",
        disabled: false,
        signals: {
          "anthropic-ratelimit-unified-7d-utilization": "0.02",
          "anthropic-ratelimit-unified-7d-reset": String((START + 7 * 24 * HOUR_MS) / 1000),
        },
        observedAt: iso(START),
      };
      backend.accounts.set("claude.json", fake);
      const object = makeMemoryPoolObject(backend.serve);
      const engine = yield* Effect.promise(() => object.runtime.runPromise(PoolEngine.PoolEngine));
      yield* engine.initialize;
      yield* TestClock.setTime(START);
      yield* engine.create(alice, { name: "Work", personal: false });
      yield* engine.setBacking(alice, {
        mode: "external",
        url: "https://proxy.test",
        managementKey: "management",
        clientKey: "client",
      });
      yield* TestClock.setTime(START + HOUR_MS);
      yield* engine.updateAccount(alice, "claude.json", "pause");
      expect(yield* engine.advice(alice)).toEqual([]);
      const now = START + 24 * HOUR_MS;
      yield* TestClock.setTime(now);
      fake.signals["anthropic-ratelimit-unified-7d-utilization"] = "0.5";
      fake.observedAt = iso(now);
      yield* engine.updateAccount(alice, "claude.json", "resume");
      expect(
        yield* Effect.promise(() =>
          object.runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql<{ total: number }>`SELECT sum(consumed) AS total FROM usage_hours`,
            ),
          ),
        ),
      ).toEqual([{ total: 48 }]);
      expect((yield* engine.advice(alice))?.[0]?.historyHours).toBe(24);
    }),
  );

  it.effect(
    "records quota observation times, preserves history on cached reads and hides advice from members",
    () =>
      Effect.gen(function* () {
        const backend = makeFakeCliProxyApi();
        const fake = {
          type: "claude",
          email: "private@example.test",
          disabled: false,
          signals: {
            "anthropic-ratelimit-unified-7d-utilization": "0.02",
            "anthropic-ratelimit-unified-7d-reset": String((START + 7 * 24 * HOUR_MS) / 1000),
          },
          observedAt: iso(START),
        };
        backend.accounts.set("claude.json", fake);
        const object = makeMemoryPoolObject(backend.serve);
        const engine = yield* Effect.promise(() =>
          object.runtime.runPromise(PoolEngine.PoolEngine),
        );
        yield* engine.initialize;
        yield* TestClock.setTime(START);
        yield* engine.create(alice, { name: "Work", personal: false });
        yield* engine.setBacking(alice, {
          mode: "external",
          url: "https://proxy.test",
          managementKey: "management",
          clientKey: "client",
        });
        expect(yield* engine.advice(alice)).toEqual([
          { driver: "claudeAgent", historyHours: 0, addAccounts: 0 },
        ]);

        const now = START + 24 * HOUR_MS;
        yield* TestClock.setTime(now);
        fake.signals["anthropic-ratelimit-unified-7d-utilization"] = "0.5";
        fake.observedAt = iso(now);
        yield* engine.updateAccount(alice, "claude.json", "resume");
        const advice = yield* engine.advice(alice);
        expect(advice).toEqual([
          {
            driver: "claudeAgent",
            historyHours: 24,
            addAccounts: 3,
            runsOut: {
              at: iso(now + 25 * HOUR_MS),
              window: "Weekly",
              backAt: iso(START + 7 * 24 * HOUR_MS),
            },
          },
        ]);

        // A fresh account list with the same old quota does not add watched hours.
        yield* TestClock.setTime(now + HOUR_MS);
        yield* engine.updateAccount(alice, "claude.json", "resume");
        expect((yield* engine.advice(alice))?.[0]?.historyHours).toBe(24);
        const sql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.promise(() => object.runtime.runPromise(effect));
        yield* sql(
          SqlClient.SqlClient.use(
            (sql) =>
              sql`INSERT INTO grants (user_id, role, granted_at) VALUES (${bob.userId}, 'member', 0)`,
          ),
        );
        expect(yield* engine.advice(bob)).toBeNull();
        expect((yield* Effect.flip(engine.advice(outsider)))._tag).toBe("PoolRejectedError");

        const pool = {
          id: "work",
          objectName: "alice:work",
          name: "Work",
          personal: false,
          backing: { mode: "managed" as const },
        };
        const accounts = yield* engine.accounts(bob);
        const source = usageSource({ pool, accounts }, now);
        expect(
          limitsSource({ pool, source, models: [], role: "member", routing: null }).accounts,
        ).toEqual([]);
        expect(
          overview(pool, source, now).providers.find(
            (provider) => provider.driver === "claudeAgent",
          )?.usage,
        ).toEqual([
          {
            kind: "weekly",
            label: "Weekly",
            remainingPercent: 50,
            nextResetAt: iso(START + 7 * 24 * HOUR_MS),
          },
        ]);
        yield* sql(
          SqlClient.SqlClient.use(
            (sql) => sql`UPDATE grants SET role = 'member' WHERE user_id = ${alice.userId}`,
          ),
        );
        expect(yield* engine.advice(alice)).toBeNull();
      }),
  );
});
