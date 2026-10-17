import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PoolContainer from "./PoolContainer.ts";
import * as PoolEngine from "./PoolEngine.ts";
import * as CliProxyApi from "./cliProxyApi.ts";
import * as PoolLimits from "./poolLimits.ts";
import * as History from "./poolUsageHistory.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const actor = { userId: "owner" };
const START = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const reset = START + 7 * 24 * 60 * 60_000;
const account = () => ({
  type: "claude",
  email: "private@example.test",
  disabled: false,
  signals: {
    "anthropic-ratelimit-unified-7d-utilization": "0.1",
    "anthropic-ratelimit-unified-7d-reset": String(reset / 1000),
  },
  observedAt: iso(START),
  usage: {
    status: 200,
    body: JSON.stringify({ seven_day: { utilization: 25, resets_at: iso(reset) } }),
  },
});

const engineOf = (object: ReturnType<typeof makeMemoryPoolObject>) =>
  Effect.gen(function* () {
    const engine = yield* Effect.promise(() => object.runtime.runPromise(PoolEngine.PoolEngine));
    yield* engine.initialize;
    return engine;
  });

const storedUse = (object: ReturnType<typeof makeMemoryPoolObject>) =>
  Effect.promise(() =>
    object.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<{ consumed: number }>`SELECT sum(consumed) AS consumed FROM usage_hours`,
      ),
    ),
  );

describe("pool usage sampling alarms", () => {
  it.effect("samples the other account on time despite repeated partial held checks", () =>
    Effect.gen(function* () {
      const backend = makeFakeCliProxyApi();
      backend.accounts.set("held.json", {
        ...account(),
        usage: {
          status: 200,
          body: JSON.stringify({
            seven_day: { utilization: 100, resets_at: iso(reset) },
          }),
        },
      });
      backend.accounts.set("busy.json", account());
      const object = makeMemoryPoolObject(backend.serve);
      const engine = yield* engineOf(object);
      yield* TestClock.setTime(START);
      yield* engine.create(actor, { name: "Work", personal: false });
      yield* engine.setBacking(actor, {
        mode: "external",
        url: "https://proxy.test",
        managementKey: "management",
        clientKey: "client",
      });
      const deadline = START + History.SAMPLE_EVERY_MS;
      expect(yield* engine.nextUsageSampleAt()).toBe(deadline);
      const endpoint: CliProxyApi.PoolEndpoint = {
        fetch: backend.serve,
        baseUrl: "https://proxy.test",
        managementKey: "management",
        clientKey: "client",
        link: false,
      };
      const live = yield* CliProxyApi.listAccounts(endpoint);
      for (const minutes of [5, 10, 14]) {
        const now = START + minutes * 60_000;
        yield* TestClock.setTime(now);
        const held = live.map((account): CliProxyApi.ListedAccount =>
          account.name === "held.json" && account.usage._tag === "observed"
            ? { ...account, usage: { ...account.usage, observedAt: now, heldUntil: reset } }
            : account,
        );
        yield* Effect.promise(() =>
          object.runtime.runPromise(PoolLimits.refresh(endpoint, held, now, "held")),
        );
        expect(yield* engine.nextUsageSampleAt()).toBe(deadline);
      }
      expect(backend.accountRequests.map((request) => request.name)).toEqual([
        "held.json",
        "held.json",
        "held.json",
      ]);
      // A free signals read also records newer quota without deferring the full-pool read.
      const freeAt = deadline - 1;
      yield* TestClock.setTime(freeAt);
      const free = live.map((account): CliProxyApi.ListedAccount =>
        account.name === "held.json" && account.usage._tag === "observed"
          ? {
              ...account,
              usage: {
                ...account.usage,
                observedAt: freeAt,
                signals: {
                  ...account.usage.signals,
                  "anthropic-ratelimit-unified-7d-utilization": "1",
                },
              },
            }
          : account,
      );
      yield* Effect.promise(() =>
        object.runtime.runPromise(PoolLimits.refresh(endpoint, free, freeAt, "free")),
      );
      expect(yield* engine.nextUsageSampleAt()).toBe(deadline);
      yield* TestClock.setTime(deadline);
      yield* engine.refreshUsageAtAlarm();
      expect(
        backend.accountRequests.filter((request) => request.name === "busy.json"),
      ).toHaveLength(1);
      const observation = yield* Effect.promise(() =>
        object.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) =>
              sql<{
                observed_at: number;
                used: number;
              }>`SELECT observed_at, used FROM usage_accounts WHERE account_id = 'busy.json'`,
          ),
        ),
      );
      expect(observation).toEqual([{ observed_at: deadline, used: 25 }]);
      expect(yield* engine.nextUsageSampleAt()).toBe(deadline + History.SAMPLE_EVERY_MS);
    }),
  );

  it.effect(
    "wakes a sleeping managed pool and records provider usage with no client or thread",
    () =>
      Effect.gen(function* () {
        const object = makeMemoryPoolObject();
        object.cliProxyApi.accounts.set("claude.json", account());
        const engine = yield* engineOf(object);
        yield* TestClock.setTime(START);
        yield* engine.create(actor, { name: "Work", personal: false });
        expect(yield* engine.nextUsageSampleAt()).toBeNull();
        // Starts the pool and discovers its accounts; no client subscriptions are opened.
        yield* engine.startLogin(actor, "claude");
        expect(yield* engine.nextUsageSampleAt()).toBe(START + History.SAMPLE_EVERY_MS);
        yield* Effect.promise(() =>
          object.runtime.runPromise(PoolContainer.PoolContainer.use((container) => container.stop)),
        );
        const starts = object.container.starts;
        yield* TestClock.setTime(START + History.SAMPLE_EVERY_MS - 1);
        yield* engine.refreshUsageAtAlarm();
        expect(object.container.starts).toBe(starts);
        yield* TestClock.setTime(START + History.SAMPLE_EVERY_MS);
        yield* engine.refreshUsageAtAlarm();
        expect(object.container.starts).toBe(starts + 1);
        expect(object.cliProxyApi.accountRequests).toHaveLength(1);
        expect(yield* storedUse(object)).toEqual([{ consumed: 15 }]);
        expect(yield* engine.nextUsageSampleAt()).toBe(START + 2 * History.SAMPLE_EVERY_MS);
        const [observation] = yield* Effect.promise(() =>
          object.runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql<{ observed_at: number }>`SELECT observed_at FROM usage_accounts`,
            ),
          ),
        );
        expect(observation?.observed_at).toBe(START + History.SAMPLE_EVERY_MS);
        // The dedicated history sample leaves account-list and catalog freshness alone.
        const [freshness] = yield* Effect.promise(() =>
          object.runtime.runPromise(
            SqlClient.SqlClient.use(
              (sql) => sql`SELECT checked_at, models_checked_at FROM accounts_state`,
            ),
          ),
        );
        expect(freshness).toEqual({ checked_at: START, models_checked_at: START });
      }),
  );

  it.effect("preserves the sampling deadline and quota baseline across a PoolEngine restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const filename = path.join(directory, "pool.sqlite");
      const backend = makeFakeCliProxyApi();
      backend.accounts.set("claude.json", account());
      const first = makeMemoryPoolObject(backend.serve, { filename });
      const engine = yield* engineOf(first);
      yield* TestClock.setTime(START);
      yield* engine.create(actor, { name: "Work", personal: false });
      yield* engine.setBacking(actor, {
        mode: "external",
        url: "https://proxy.test",
        managementKey: "management",
        clientKey: "client",
      });
      expect(yield* engine.nextUsageSampleAt()).toBe(START + History.SAMPLE_EVERY_MS);
      yield* Effect.promise(() => first.runtime.dispose());
      yield* TestClock.setTime(START + History.SAMPLE_EVERY_MS - 1);
      const second = makeMemoryPoolObject(backend.serve, { filename });
      const restarted = yield* engineOf(second);
      expect(yield* restarted.nextUsageSampleAt()).toBe(START + History.SAMPLE_EVERY_MS);
      yield* restarted.refreshUsageAtAlarm();
      expect(backend.accountRequests).toHaveLength(0);
      yield* TestClock.setTime(START + History.SAMPLE_EVERY_MS);
      yield* restarted.refreshUsageAtAlarm();
      expect(backend.accountRequests).toHaveLength(1);
      expect(yield* storedUse(second)).toEqual([{ consumed: 15 }]);
      const next = START + 2 * History.SAMPLE_EVERY_MS;
      expect(yield* restarted.nextUsageSampleAt()).toBe(next);
      yield* Effect.promise(() => second.runtime.dispose());
      yield* TestClock.setTime(next + 1);
      const third = makeMemoryPoolObject(backend.serve, { filename });
      const overdue = yield* engineOf(third);
      expect(yield* overdue.nextUsageSampleAt()).toBe(next);
      yield* overdue.refreshUsageAtAlarm();
      expect(backend.accountRequests).toHaveLength(2);
      expect(yield* overdue.nextUsageSampleAt()).toBe(next + 1 + History.SAMPLE_EVERY_MS);
      yield* Effect.promise(() => third.runtime.dispose());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds a stuck background read and durably postpones its next attempt", () =>
    Effect.gen(function* () {
      const backend = makeFakeCliProxyApi();
      backend.accounts.set("claude.json", account());
      const began = yield* Deferred.make<void>();
      let stuck = false;
      const object = makeMemoryPoolObject((request) => {
        if (stuck && new URL(request.url).pathname.endsWith("/credentials")) {
          Deferred.doneUnsafe(began, Effect.void);
          return new Promise<Response>(() => {});
        }
        return backend.serve(request);
      });
      const engine = yield* engineOf(object);
      yield* TestClock.setTime(START);
      yield* engine.create(actor, { name: "Work", personal: false });
      yield* engine.setBacking(actor, {
        mode: "external",
        url: "https://proxy.test",
        managementKey: "management",
        clientKey: "client",
      });
      // PoolObject schedules this after setBacking; free reads no longer create a deadline.
      expect(yield* engine.nextUsageSampleAt()).toBe(START + History.SAMPLE_EVERY_MS);
      yield* TestClock.setTime(START + History.SAMPLE_EVERY_MS);
      stuck = true;
      const sample = yield* Effect.forkChild(engine.refreshUsageAtAlarm());
      yield* Deferred.await(began);
      expect(yield* engine.nextUsageSampleAt()).toBe(START + 2 * History.SAMPLE_EVERY_MS);
      yield* TestClock.adjust(PoolEngine.ACCOUNTS_REFRESH_TIMEOUT_MS);
      yield* Fiber.join(sample);
      stuck = false;
      yield* engine.refreshUsageAtAlarm();
      expect(backend.accountRequests).toHaveLength(0);
      expect(yield* storedUse(object)).toEqual([{ consumed: 0 }]);
    }),
  );
});
