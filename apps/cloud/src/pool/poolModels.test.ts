import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { handleFor } from "./PoolDirectory.ts";
import * as PoolModels from "./poolModels.ts";
import { makeMemoryPoolObject } from "./testing.ts";

const actor = { userId: "user_alice" };

describe("pool model cache", () => {
  it.effect("round-trips metadata and keeps the last successful list after a failed read", () =>
    Effect.gen(function* () {
      const object = makeMemoryPoolObject();
      yield* handleFor(object.api).create(actor, { name: "Personal", personal: true });

      const initial: ReadonlyArray<PoolModels.PoolModels["models"][number]> = [
        {
          id: "gpt-6.1-sol",
          ownedBy: "openai",
          created: 1,
          displayName: "GPT-6.1 Sol",
          provider: "codex",
          reasoningEfforts: ["low", "high"],
        },
      ];
      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.store(initial, 10)));
      expect(yield* Effect.promise(() => object.runtime.runPromise(PoolModels.cached))).toEqual({
        checkedAt: 10,
        attemptedAt: 10,
        models: initial,
      });

      const refreshed = [{ ...initial[0]!, displayName: "GPT Sol", reasoningEfforts: [] }];
      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.store(refreshed, 20)));
      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.markAttempted(30)));

      expect(yield* Effect.promise(() => object.runtime.runPromise(PoolModels.cached))).toEqual({
        checkedAt: 20,
        attemptedAt: 30,
        models: refreshed,
      });
    }),
  );
});
