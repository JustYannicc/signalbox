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
        accountModels: initial,
        localModels: [],
        models: initial,
      });

      const refreshed = [{ ...initial[0]!, displayName: "GPT Sol", reasoningEfforts: [] }];
      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.store(refreshed, 20)));
      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.markAttempted(30)));

      expect(yield* Effect.promise(() => object.runtime.runPromise(PoolModels.cached))).toEqual({
        checkedAt: 20,
        attemptedAt: 30,
        accountModels: refreshed,
        localModels: [],
        models: refreshed,
      });
    }),
  );

  it.effect("keeps local registrations separate when the CLI catalog is replaced", () =>
    Effect.gen(function* () {
      const object = makeMemoryPoolObject();
      yield* handleFor(object.api).create(actor, { name: "Personal", personal: true });
      const account = [{ id: "claude-account-model", ownedBy: "anthropic", created: 1 }];
      const local = [{ id: "claude-local-model", ownedBy: "anthropic", created: null }];

      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.storeLocal("local", local)));
      yield* Effect.promise(() => object.runtime.runPromise(PoolModels.store(account, 10)));
      const cached = yield* Effect.promise(() => object.runtime.runPromise(PoolModels.cached));

      expect(cached.accountModels).toEqual(account);
      expect(cached.localModels).toEqual([
        {
          ...local[0],
          provider: "claude",
          registration: { kind: "local", transportId: "local" },
        },
      ]);
      expect(cached.models.map((model) => model.id)).toEqual([
        "claude-account-model",
        "claude-local-model",
      ]);
      expect(
        cached.models.find((model) => model.id === "claude-local-model")?.registration,
      ).toEqual({ kind: "local", transportId: "local" });
    }),
  );
});
