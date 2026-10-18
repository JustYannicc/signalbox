import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as PoolEngine from "./PoolEngine.ts";
import * as History from "./poolUsageHistory.ts";
import { makeFakeCliProxyApi, makeMemoryPoolObject } from "./testing.ts";

const actor = { userId: "owner" };
const T0 = Date.parse("2026-10-18T10:00:00Z");

describe("pool account refresh concurrency", () => {
  it.effect("refreshes stale accounts while an alarm usage probe is held", () =>
    Effect.gen(function* () {
      const backend = makeFakeCliProxyApi();
      backend.accounts.set("claude.json", {
        type: "claude",
        email: "user@example.test",
        disabled: false,
      });
      const probing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const object = makeMemoryPoolObject((request) => {
        if (new URL(request.url).pathname.endsWith("/requests/api-call")) {
          Deferred.doneUnsafe(probing, Effect.void);
          return object.runtime
            .runPromise(Deferred.await(release))
            .then(() => backend.serve(request));
        }
        return backend.serve(request);
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => object.runtime.dispose()));
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const engine = yield* Effect.promise(() => object.runtime.runPromise(PoolEngine.PoolEngine));
      yield* engine.initialize;
      yield* TestClock.setTime(T0);
      yield* engine.create(actor, { name: "Work", personal: false });
      yield* engine.setBacking(actor, {
        mode: "external",
        url: "https://proxy.test",
        managementKey: "management",
        clientKey: "client",
      });
      const sampleAt = T0 + History.SAMPLE_EVERY_MS;
      expect(yield* engine.nextUsageSampleAt()).toBe(sampleAt);
      yield* TestClock.setTime(sampleAt);
      const alarm = yield* Effect.forkChild(engine.refreshUsageAtAlarm());
      yield* Deferred.await(probing);
      const read = yield* Effect.forkChild(engine.accounts(actor));
      yield* TestClock.adjust(PoolEngine.ACCOUNTS_READ_TIMEOUT_MS + 1);
      const snapshot = yield* Fiber.join(read);
      expect(snapshot.checkedAt).toBe(sampleAt);
      expect(snapshot.error).toBeNull();
      expect(snapshot.accounts).toEqual([
        expect.objectContaining({ name: "claude.json", signedOut: false }),
      ]);
      expect(yield* Deferred.isDone(release)).toBe(false);
      yield* engine.logoutAccount(actor, "claude", "claude.json");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(alarm);
      expect((yield* engine.accounts(actor)).accounts[0]?.signedOut).toBe(true);
    }).pipe(Effect.scoped),
  );
});
