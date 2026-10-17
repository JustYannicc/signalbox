import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as PoolContainer from "./PoolContainer.ts";
import * as PoolEngine from "./PoolEngine.ts";
import { SAMPLE_EVERY_MS } from "./poolUsageHistory.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const actor = { userId: "owner" };
const START = Date.parse("2026-10-05T08:00:00.000Z");

const setup = (type: string | null, disabled = false) =>
  Effect.gen(function* () {
    const object = makeMemoryPoolObject();
    if (type !== null)
      object.cliProxyApi.accounts.set("account.json", {
        type,
        email: "private@example.test",
        disabled,
      });
    const engine = yield* Effect.promise(() => object.runtime.runPromise(PoolEngine.PoolEngine));
    yield* engine.initialize;
    yield* TestClock.setTime(START);
    yield* engine.create(actor, { name: "Work", personal: false });
    yield* engine.startLogin(actor, "claude");
    return { object, engine };
  });

const stop = (object: ReturnType<typeof makeMemoryPoolObject>) =>
  Effect.promise(() =>
    object.runtime.runPromise(PoolContainer.PoolContainer.use((container) => container.stop)),
  );

describe("usage sampling eligibility", () => {
  it.effect.each([
    { name: "empty", type: null, disabled: false, signedOut: false },
    { name: "paused", type: "claude", disabled: true, signedOut: false },
    { name: "signed out", type: "codex", disabled: false, signedOut: true },
    { name: "unsupported", type: "xai", disabled: false, signedOut: false },
  ])("does not wake a $name pool for usage sampling", ({ type, disabled, signedOut }) =>
    Effect.gen(function* () {
      const { object, engine } = yield* setup(type, disabled);
      if (signedOut)
        yield* Effect.promise(() =>
          object.runtime.runPromise(
            SqlClient.SqlClient.use((sql) => sql`UPDATE accounts SET signed_out = 1`),
          ),
        );
      const models = yield* engine.nextModelsRefreshAt();
      expect(models === null).toBe(type === null);
      expect(yield* engine.nextUsageSampleAt()).toBeNull();
      yield* stop(object);
      const starts = object.container.starts;
      const requests = object.cliProxyApi.accountRequests.length;
      yield* TestClock.setTime(START + 2 * SAMPLE_EVERY_MS);
      yield* engine.refreshUsageAtAlarm();
      expect(yield* engine.nextUsageSampleAt()).toBeNull();
      expect(object.container.starts).toBe(starts);
      expect(object.cliProxyApi.accountRequests).toHaveLength(requests);
      expect(yield* engine.nextModelsRefreshAt()).toBe(models);
    }),
  );

  it.effect("resumes quarter-hourly sampling when a paused readable account becomes eligible", () =>
    Effect.gen(function* () {
      const { object, engine } = yield* setup("claude", true);
      expect(yield* engine.nextUsageSampleAt()).toBeNull();
      const resumedAt = START + SAMPLE_EVERY_MS;
      yield* TestClock.setTime(resumedAt);
      yield* engine.updateAccount(actor, "account.json", "resume");
      const deadline = resumedAt + SAMPLE_EVERY_MS;
      expect(yield* engine.nextUsageSampleAt()).toBe(deadline);
      yield* stop(object);
      const starts = object.container.starts;
      yield* TestClock.setTime(deadline - 1);
      yield* engine.refreshUsageAtAlarm();
      expect(object.container.starts).toBe(starts);
      yield* TestClock.setTime(deadline);
      yield* engine.refreshUsageAtAlarm();
      expect(object.container.starts).toBe(starts + 1);
      expect(object.cliProxyApi.accountRequests).toHaveLength(1);
      expect(yield* engine.nextUsageSampleAt()).toBe(deadline + SAMPLE_EVERY_MS);
    }),
  );
});
