import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export class DesktopCaptureFlushError extends Schema.TaggedError<DesktopCaptureFlushError>()(
  "DesktopCaptureFlushError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Quick capture couldn't finish saving. Signalbox is still open. Try again.";
  }
}

interface CaptureFlushTransport {
  /** False only when no capture panel exists. */
  readonly request: (requestId: string) => Effect.Effect<boolean>;
  readonly release: (error: string | null) => Effect.Effect<void>;
}

export class DesktopCaptureShutdown extends Context.Service<
  DesktopCaptureShutdown,
  {
    readonly register: (
      transport: CaptureFlushTransport,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly flush: Effect.Effect<void, DesktopCaptureFlushError>;
    readonly complete: (result: {
      readonly requestId: string;
      readonly error: string | null;
    }) => Effect.Effect<void>;
    readonly release: Effect.Effect<void>;
  }
>()("@t3tools/desktop/capture/DesktopCaptureShutdown") {}

const make = Effect.gen(function* () {
  const transportRef = yield* Ref.make<CaptureFlushTransport | null>(null);
  const pendingRef = yield* Ref.make<{
    readonly requestId: string;
    readonly result: Deferred.Deferred<void, DesktopCaptureFlushError>;
  } | null>(null);
  const lock = yield* Semaphore.make(1);
  const sequence = yield* Ref.make(0);

  const release = (error: string | null) =>
    Effect.gen(function* () {
      const transport = yield* Ref.get(transportRef);
      if (transport) yield* transport.release(error);
    });

  const flush = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const transport = yield* Ref.get(transportRef);
        if (!transport) return;
        const requestId = String(yield* Ref.updateAndGet(sequence, (value) => value + 1));
        const result = yield* Deferred.make<void, DesktopCaptureFlushError>();
        yield* Ref.set(pendingRef, { requestId, result });
        yield* Effect.gen(function* () {
          if (!(yield* transport.request(requestId))) return;
          // A dead renderer must cancel the quit, not silently count as a committed draft.
          yield* Deferred.await(result).pipe(Effect.timeout("30 seconds"));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const error = new DesktopCaptureFlushError({ cause });
              yield* release(error.message).pipe(Effect.ignoreCause);
              return yield* Effect.fail(error);
            }),
          ),
          Effect.ensuring(Ref.set(pendingRef, null)),
        );
      }),
    )
    .pipe(Effect.withSpan("desktop.capture.flushBeforeShutdown"));

  return DesktopCaptureShutdown.of({
    register: (transport) =>
      Effect.acquireRelease(Ref.set(transportRef, transport), () =>
        Effect.gen(function* () {
          if ((yield* Ref.get(transportRef)) !== transport) return;
          yield* Ref.set(transportRef, null);
          const pending = yield* Ref.get(pendingRef);
          if (pending)
            yield* Deferred.fail(
              pending.result,
              new DesktopCaptureFlushError({ cause: "Capture panel disconnected." }),
            );
        }),
      ),
    flush,
    complete: ({ requestId, error }) =>
      Effect.gen(function* () {
        const pending = yield* Ref.get(pendingRef);
        if (!pending || pending.requestId !== requestId) return;
        if (error === null) yield* Deferred.succeed(pending.result, undefined);
        else yield* Deferred.fail(pending.result, new DesktopCaptureFlushError({ cause: error }));
      }),
    release: release(null),
  });
});

export const layer = Layer.effect(DesktopCaptureShutdown, make);
