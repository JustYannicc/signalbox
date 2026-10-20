import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestContext,
} from "../HarnessRequestFacet.ts";

export const failure = (message: string, cause?: unknown) =>
  new HarnessRequestFacetError(message, { cause });

const ExpectedRequest = Context.Reference<HarnessFacetRequestContext | undefined>(
  "@signalbox/cloud/harness/requestTurn/ExpectedRequest",
  { defaultValue: () => undefined },
);

export const createRequestGate = Effect.gen(function* () {
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  let active: HarnessFacetRequestContext | undefined;
  let controller = new AbortController();
  let external = false;
  let pending = 0;
  let pendingFailure: HarnessRequestFacetError | undefined;
  let idle = yield* Deferred.make<void>();
  yield* Deferred.succeed(idle, undefined);

  const current = () => {
    if (active === undefined || active.signal.aborted || controller.signal.aborted)
      throw failure("Harness request authority is inactive.");
    return active;
  };
  const checked = (expected?: HarnessFacetRequestContext, outside = false) =>
    Effect.gen(function* () {
      const context = yield* Effect.try({
        try: current,
        catch: (cause) => failure("Harness request authority is inactive.", cause),
      });
      if ((expected !== undefined && context !== expected) || (outside && !external))
        return yield* Effect.fail(
          failure("Harness external admission belongs to an ended request."),
        );
      yield* context.check;
      if (
        active !== context ||
        context.signal.aborted ||
        controller.signal.aborted ||
        (outside && !external)
      )
        return yield* Effect.fail(failure("Harness request changed during admission."));
      return context;
    });
  const hold = () => {
    if (pending++ === 0) idle = Deferred.makeUnsafe<void>();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--pending === 0) Deferred.doneUnsafe(idle, Effect.void);
    };
  };
  const admit = <A, E, R>(
    operation: (context: HarnessFacetRequestContext) => Effect.Effect<A, E, R>,
    outside = false,
    expected?: HarnessFacetRequestContext,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = yield* restore(checked(expected, outside));
        const release = hold();
        return yield* restore(Effect.suspend(() => operation(context))).pipe(
          Effect.ensuring(Effect.sync(release)),
        );
      }),
    );
  const promise = <A>(
    operation: (context: HarnessFacetRequestContext, signal: AbortSignal) => Promise<A>,
    outside = true,
    expected?: HarnessFacetRequestContext,
  ) =>
    runPromise(
      admit(
        (context) =>
          Effect.tryPromise({
            try: (signal) =>
              operation(context, AbortSignal.any([signal, context.signal, controller.signal])),
            catch: (cause) =>
              failure("Harness admitted operation failed; reconcile accepted effects.", cause),
          }),
        outside,
        expected,
      ),
    );
  return {
    check: checked(undefined, true).pipe(Effect.asVoid),
    signal: () => {
      current();
      return AbortSignal.any([active!.signal, controller.signal]);
    },
    admit,
    withRequest: <A, E, R>(effect: Effect.Effect<A, E, R>, context: HarnessFacetRequestContext) =>
      effect.pipe(Effect.provideService(ExpectedRequest, context)),
    native: <A, E, R>(operation: () => Effect.Effect<A, E, R>, outside = true) => {
      const invoked = active;
      return Effect.gen(function* () {
        // Canonical turn fibers inherit this token across setup awaits and scoped forks.
        const inherited = yield* ExpectedRequest;
        const expected = inherited ?? invoked;
        if (expected === undefined)
          return yield* Effect.fail(failure("Native operation has no owning Harness request."));
        if (inherited !== undefined && invoked !== inherited)
          return yield* Effect.fail(
            failure("Native operation crossed its owning Harness request."),
          );
        return yield* admit(operation, outside, expected);
      });
    },
    promise,
    hold,
    drain: Effect.suspend(() => Deferred.await(idle)).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          pendingFailure === undefined ? Effect.void : Effect.fail(pendingFailure),
        ),
      ),
    ),
    trackExit(exited: Promise<unknown>) {
      const release = hold();
      void exited.then(release, (cause: unknown) => {
        pendingFailure ??= failure(
          "An admitted command has no exit receipt; reconcile it before recovery.",
          cause,
        );
        release();
      });
    },
    seal: () => {
      external = false;
    },
    enter(context: HarnessFacetRequestContext) {
      if (active !== undefined || pending !== 0)
        throw failure("Harness request work is still owned.");
      controller = new AbortController();
      active = context;
      external = true;
    },
    leave() {
      external = false;
      active = undefined;
      controller.abort();
    },
  };
});

export type RequestGate = Effect.Success<typeof createRequestGate>;
