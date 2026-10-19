import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

import { HarnessError, type HarnessSession } from "../Harness.ts";

interface OpeningLifetime {
  readonly abort: () => void;
  readonly close: Effect.Effect<void>;
}

interface Opening {
  cancelled: boolean;
  lifetime?: OpeningLifetime;
  readonly ready: Deferred.Deferred<Fiber.Fiber<HarnessSession, HarnessError>>;
}

const cancel = (opening: Opening) =>
  Effect.gen(function* () {
    opening.cancelled = true;
    // Native acquisition may be uninterruptible until its session signal is aborted.
    opening.lifetime?.abort();
    const fiber = yield* Deferred.await(opening.ready);
    opening.lifetime?.abort();
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    // A worker can lose its success value after consuming its failure cleanup handler.
    const closed = yield* (opening.lifetime?.close ?? Effect.void).pipe(Effect.exit);
    const reasons = [
      ...(Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? exit.cause.reasons : []),
      ...(Exit.isFailure(closed) ? closed.cause.reasons : []),
    ];
    if (reasons.length > 0)
      return yield* Effect.failCause(Cause.fromReasons(reasons)).pipe(Effect.orDie);
  });

/** Pending native acquisitions must settle before owner shutdown closes their resource Scopes. */
export function makeFacetOpenings() {
  const pending = new Set<Opening>();
  const cancelPending = (opening: Opening) =>
    cancel(opening).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) pending.delete(opening);
        }),
      ),
    );
  return {
    close: Effect.gen(function* () {
      const openings = Array.from(pending);
      for (const opening of openings) opening.lifetime?.abort();
      const exits = yield* Effect.forEach(openings, (opening) =>
        cancelPending(opening).pipe(Effect.exit),
      );
      const cause = Cause.fromReasons(
        exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : [])),
      );
      if (cause.reasons.length > 0) return yield* Effect.failCause(cause);
    }),
    open: (
      owner: { readonly scope: Scope.Scope; readonly signal: AbortSignal },
      build: (
        register: (lifetime: OpeningLifetime) => void,
      ) => Effect.Effect<HarnessSession, HarnessError>,
    ): Effect.Effect<HarnessSession, HarnessError> =>
      Effect.withFiber((caller) =>
        Effect.callback((resume) => {
          const opening: Opening = {
            cancelled: false,
            ready: Deferred.makeUnsafe<Fiber.Fiber<HarnessSession, HarnessError>>(),
          };
          pending.add(opening);
          // Async cancellation is installed before native acquisition can run.
          const fiber = Effect.runForkWith(caller.context)(
            Effect.yieldNow.pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  build((lifetime) => {
                    opening.lifetime = lifetime;
                  }),
                ),
              ),
            ),
          );
          Fiber.runIn(fiber, owner.scope);
          Deferred.doneUnsafe(opening.ready, Effect.succeed(fiber));
          fiber.addObserver((exit) => {
            if (Exit.isSuccess(exit) && owner.signal.aborted) {
              resume(
                exit.value.dispose.pipe(
                  Effect.orDie,
                  Effect.andThen(
                    Effect.fail(
                      new HarnessError({
                        operation: "open",
                        message: "Harness facet is disposed.",
                      }),
                    ),
                  ),
                ),
              );
            } else if (
              Exit.isFailure(exit) &&
              owner.signal.aborted &&
              Cause.hasInterruptsOnly(exit.cause)
            ) {
              resume(
                Effect.fail(
                  new HarnessError({
                    operation: "open",
                    message: "Harness facet is disposed.",
                  }),
                ),
              );
            } else resume(exit);
            // Failed cleanup must remain visible to owner shutdown too.
            if (!opening.cancelled && !(Exit.isFailure(exit) && Cause.hasDies(exit.cause)))
              pending.delete(opening);
          });
          return cancelPending(opening);
        }),
      ),
  };
}
