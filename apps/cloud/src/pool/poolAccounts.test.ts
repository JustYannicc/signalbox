import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as PoolEngine from "./PoolEngine.ts";
import * as PoolLimits from "./poolLimits.ts";
import { handleFor } from "./PoolDirectory.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const alice = { userId: "user_alice" };
const T0 = Date.parse("2026-10-17T10:00:00.000Z");
const CLAUDE_USAGE = JSON.stringify({
  five_hour: { utilization: 30, resets_at: "2026-10-17T12:00:00.000Z" },
  seven_day: { utilization: 40, resets_at: "2026-10-20T00:00:00.000Z" },
});
const CLAUDE_USAGE_REFRESHED = JSON.stringify({
  five_hour: { utilization: 60, resets_at: "2026-10-17T12:00:00.000Z" },
  seven_day: { utilization: 70, resets_at: "2026-10-20T00:00:00.000Z" },
});

describe("PoolEngine account snapshots", () => {
  it.effect(
    "keeps an unchanged snapshot fresh while an external usage probe hangs, then retries",
    () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      const external = makeFakeCliProxyApi();
      let blocked = false;
      let probeCalls = 0;
      const pendingProbes: Array<() => void> = [];
      let signalStart!: () => void;
      let started = new Promise<void>((resolve) => {
        signalStart = resolve;
      });
      let didSignalStart = false;
      const object = makeMemoryPoolObject((request) => {
        if (new URL(request.url).pathname.endsWith("/requests/api-call")) {
          probeCalls += 1;
          if (!blocked) return external.serve(request);
          if (!didSignalStart) {
            didSignalStart = true;
            signalStart();
          }
          return new Promise<Response>((resolve, reject) => {
            pendingProbes.push(() => {
              void external.serve(request).then(resolve, reject);
            });
          });
        }
        return external.serve(request);
      });
      const pool = handleFor(object.api);

      return Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        yield* pool.create(alice, { name: "Personal", personal: true });
        yield* pool.setBacking(alice, {
          mode: "external",
          url: "https://proxy.example.test",
          managementKey: "management",
          clientKey: "client",
        });
        const login = yield* pool.startLogin(alice, "claude");
        yield* pool.completeLogin(alice, `http://localhost/callback?code=c&state=${login.state}`);
        yield* pool.loginStatus(alice, login.state);
        const accountName = [...external.accounts.keys()][0];
        if (accountName === undefined)
          throw new Error("Expected the external login to add an account");
        const fakeAccount = external.accounts.get(accountName);
        if (fakeAccount === undefined) throw new Error("Expected the external account to exist");
        fakeAccount.usage = { status: 200, body: CLAUDE_USAGE };

        const initial = yield* pool.accounts(alice);
        expect(initial.accounts.map((account) => account.name)).toEqual([accountName]);
        expect(initial.models.map((model) => model.id)).toContain("claude-opus-5-5");
        expect(initial.error).toBeNull();
        fakeAccount.usage = { status: 200, body: CLAUDE_USAGE_REFRESHED };
        const probesBeforeStall = probeCalls;

        const staleAt = T0 + PoolLimits.PROBE_INTERVAL_MS + 1;
        vi.setSystemTime(staleAt);
        yield* TestClock.setTime(staleAt);
        blocked = true;
        const read = yield* Effect.forkChild(pool.accounts(alice));
        yield* Effect.promise(() => started);

        vi.setSystemTime(staleAt + PoolEngine.ACCOUNTS_READ_TIMEOUT_MS + 1);
        yield* TestClock.adjust(PoolEngine.ACCOUNTS_READ_TIMEOUT_MS + 1);
        const timedOut = yield* Fiber.join(read);

        expect(timedOut.accounts.map((account) => account.name)).toEqual([accountName]);
        expect(timedOut.models.map((model) => model.id)).toContain("claude-opus-5-5");
        expect(timedOut.error).toBeNull();
        expect(probeCalls).toBe(probesBeforeStall + 1);

        // linkInfo shares the same in-flight refresh while the probe is still blocked.
        const linkRead = yield* Effect.forkChild(
          Effect.promise(() =>
            object.runtime.runPromise(
              PoolEngine.PoolEngine.use((engine) => engine.linkInfo(alice)),
            ),
          ),
        );
        vi.setSystemTime(staleAt + 2 * (PoolEngine.ACCOUNTS_READ_TIMEOUT_MS + 1));
        yield* TestClock.adjust(PoolEngine.ACCOUNTS_READ_TIMEOUT_MS + 1);
        const linked = yield* Fiber.join(linkRead);
        expect(linked.accounts.map((account) => account.name)).toEqual([accountName]);
        expect(probeCalls).toBe(probesBeforeStall + 1);

        blocked = false;
        for (const release of pendingProbes) release();
        yield* Effect.yieldNow;

        const recovered = yield* pool.accounts(alice);
        expect(probeCalls).toBe(probesBeforeStall + 1);
        expect(recovered.error).toBeNull();
        expect(
          recovered.accounts[0]?.usageLimits?.windows.map((window) => window.usedPercent),
        ).toEqual([60, 70]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            blocked = false;
            for (const release of pendingProbes) release();
            vi.useRealTimers();
          }),
        ),
      );
    },
  );
});
