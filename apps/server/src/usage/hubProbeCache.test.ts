import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, type UsageLimitSourceAccount } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { HubProviderRateLimited, makeHubProbeCache } from "./hubProbeCache.ts";

const account = (usedPercent: number): UsageLimitSourceAccount => ({
  id: "claude.json",
  driver: ProviderDriverKind.make("claudeAgent"),
  usageLimits: {
    checkedAt: "2026-10-06T12:00:00.000Z",
    windows: [{ kind: "session", id: "five_hour", label: "Session", usedPercent }],
  },
});

describe("hub usage probes", () => {
  it.effect.each(["failure", "rate limited", "missing numbers"] as const)(
    "drops a fallback that expires while a slow probe returns %s",
    (outcome) =>
      Effect.gen(function* () {
        const probes = yield* makeHubProbeCache;
        yield* probes.read("hub:slow", Effect.succeed(account(10)));
        yield* TestClock.adjust("14 minutes");
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const unavailable: UsageLimitSourceAccount = {
          ...account(0),
          usageLimits: {
            checkedAt: "2026-10-06T12:15:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed", message: "No usage numbers." },
          },
        };
        const error =
          outcome === "rate limited"
            ? new HubProviderRateLimited({ detail: "rate limited" })
            : "probe failed";
        const slow = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(finish);
          return yield* outcome === "missing numbers"
            ? Effect.succeed(unavailable)
            : Effect.fail(error);
        });
        const reading = yield* probes.read("hub:slow", slow).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.succeed(finish, undefined);
        const result = yield* Fiber.join(reading);
        if (outcome === "missing numbers") {
          expect(result).toMatchObject({ _tag: "Success", success: unavailable });
        } else {
          expect(result).toMatchObject({ _tag: "Failure", failure: error });
        }
      }),
  );

  it.effect("probe at most once a minute, and keep the last good read through a 429", () =>
    Effect.gen(function* () {
      const probes = yield* makeHubProbeCache;
      let calls = 0;
      let answer: Effect.Effect<UsageLimitSourceAccount, HubProviderRateLimited> = Effect.succeed(
        account(10),
      );
      const probe = Effect.suspend(() => {
        calls += 1;
        return answer;
      });

      expect((yield* probes.read("hub:claude", probe)).usageLimits.windows[0]?.usedPercent).toBe(
        10,
      );
      // A page visit straight after does not reach the provider again.
      yield* probes.read("hub:claude", probe);
      expect(calls).toBe(1);

      yield* TestClock.adjust("61 seconds");
      answer = Effect.fail(new HubProviderRateLimited({ detail: "rate limited" }));
      expect((yield* probes.read("hub:claude", probe)).usageLimits.windows[0]?.usedPercent).toBe(
        10,
      );
      expect(calls).toBe(2);

      // Backing off: a minute later is still too soon after a 429.
      yield* TestClock.adjust("2 minutes");
      yield* probes.read("hub:claude", probe);
      expect(calls).toBe(2);

      yield* TestClock.adjust("4 minutes");
      answer = Effect.succeed(account(30));
      expect((yield* probes.read("hub:claude", probe)).usageLimits.windows[0]?.usedPercent).toBe(
        30,
      );

      // A redeemed reset is read fresh.
      yield* probes.expire("hub:claude");
      answer = Effect.succeed(account(0));
      expect((yield* probes.read("hub:claude", probe)).usageLimits.windows[0]?.usedPercent).toBe(0);
    }),
  );

  it.effect("does not call an ordinary failure rate limiting, and lets old reads go", () =>
    Effect.gen(function* () {
      const probes = yield* makeHubProbeCache;
      let calls = 0;
      const failing = Effect.suspend(() => {
        calls += 1;
        return Effect.fail("decode failed" as const);
      });
      expect(yield* Effect.flip(probes.read("hub:x", failing))).toBe("decode failed");
      // Not rate limited, so nothing is held back: the next read tries again.
      expect(yield* Effect.flip(probes.read("hub:x", failing))).toBe("decode failed");
      expect(calls).toBe(2);

      yield* probes.read("hub:y", Effect.succeed(account(10)));
      yield* TestClock.adjust("16 minutes");
      // A quarter-hour-old read is too old to stand in for a failed one.
      expect(yield* Effect.flip(probes.read("hub:y", failing))).toBe("decode failed");
    }),
  );

  it.effect("fails when there is no good read to fall back on", () =>
    Effect.gen(function* () {
      const probes = yield* makeHubProbeCache;
      const error = yield* Effect.flip(
        probes.read("hub:new", Effect.fail(new HubProviderRateLimited({ detail: "rate limited" }))),
      );
      expect(error._tag).toBe("HubProviderRateLimited");
    }),
  );
});
