// @effect-diagnostics abortControllerInEffect:off - abort must precede native finalizers; Effect.abortSignal's LIFO finalizer would follow them.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

/** Cancellation must precede native cleanup, including when the parent closes its Scope. */
export const makeFacetLifetime = (
  parent: Scope.Scope,
  onClosed: (exit: Exit.Exit<void>) => Effect.Effect<void> = () => Effect.void,
  beforeClose: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const guard = yield* Scope.fork(parent);
    const scope = yield* Scope.make();
    const controller = new AbortController();
    const release = yield* Effect.cached(
      Effect.sync(() => controller.abort()).pipe(
        Effect.andThen(beforeClose),
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.onExit(onClosed),
        Effect.uninterruptible,
      ),
    );
    yield* Scope.addFinalizer(guard, release);
    const close = yield* Effect.cached(
      release.pipe(Effect.ensuring(Scope.close(guard, Exit.void)), Effect.uninterruptible),
    );
    return { scope, signal: controller.signal, abort: () => controller.abort(), close };
  });
