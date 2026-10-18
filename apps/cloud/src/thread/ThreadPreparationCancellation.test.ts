import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { freshDatabase, owner, withObject } from "./runnerTesting.ts";
import { loadingPreparation } from "./preparationTesting.ts";

describe("preparation cancellation confirmation", () => {
  it.effect("cancel does not return true before its addressed runner acknowledges the stop", () =>
    withObject(freshDatabase(), (engine, runner) =>
      Effect.gen(function* () {
        const { target, say } = yield* loadingPreparation(engine, runner);
        const updates = yield* engine.subscribePreparation(owner);
        const completed = yield* Deferred.make<void>();
        const cancel = yield* engine.cancelPreparation(owner, target).pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
          Effect.forkChild,
        );
        yield* updates.pipe(
          Stream.filter((value) => value?.cancellationRequested === true),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* TestClock.adjust("29 seconds");
        expect(yield* Deferred.isDone(completed)).toBe(false);
        yield* say({
          type: "batch",
          sequence: 1,
          items: [{ kind: "preparation.cancelled", ...target }],
        });
        expect(yield* Fiber.join(cancel)).toEqual({ cancelled: true });
        expect(yield* engine.cancelPreparation(owner, target)).toEqual({ cancelled: true });
      }),
    ),
  );
  it.effect(
    "times out a missing cancellation acknowledgement truthfully and remains recoverable",
    () =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          const { target, say } = yield* loadingPreparation(engine, runner);
          const updates = yield* engine.subscribePreparation(owner);
          const cancelled = yield* engine
            .cancelPreparation(owner, target)
            .pipe(Effect.flip, Effect.forkChild);
          yield* updates.pipe(
            Stream.filter((value) => value?.cancellationRequested === true),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* TestClock.adjust("30 seconds");
          expect(yield* Fiber.join(cancelled)).toMatchObject({
            _tag: "WorktreeSetupError",
            message: expect.stringContaining("has not stopped yet"),
          });
          expect((yield* engine.preparation)?.status).toBe("cancelling");
          yield* say({
            type: "batch",
            sequence: 1,
            items: [{ kind: "preparation.cancelled", ...target }],
          });
          expect(yield* engine.cancelPreparation(owner, target)).toEqual({ cancelled: true });
          expect(
            yield* engine
              .cancelPreparation(owner, {
                ...target,
                preparationGeneration: target.preparationGeneration + 1,
              })
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "WorktreeSetupError" });
        }),
      ),
  );
});
