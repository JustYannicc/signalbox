import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopCaptureShutdown from "./DesktopCaptureShutdown.ts";

describe("capture shutdown acknowledgement", () => {
  it.effect("waits for the matching committed snapshot and ignores an old reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* DesktopCaptureShutdown.DesktopCaptureShutdown;
        const requested = yield* Deferred.make<string>();
        const completed = yield* Deferred.make<void>();
        yield* capture.register({
          request: (id) => Deferred.succeed(requested, id).pipe(Effect.as(true)),
          release: () => Effect.void,
        });
        const flushing = yield* capture.flush.pipe(
          Effect.andThen(Deferred.succeed(completed, undefined)),
          Effect.forkChild,
        );
        const requestId = yield* Deferred.await(requested);
        assert.isFalse(yield* Deferred.isDone(completed));
        yield* capture.complete({ requestId: "old-request", error: null });
        assert.isFalse(yield* Deferred.isDone(completed));
        yield* capture.complete({ requestId, error: null });
        yield* Fiber.join(flushing);
        assert.isTrue(yield* Deferred.isDone(completed));
      }),
    ).pipe(Effect.provide(DesktopCaptureShutdown.layer)),
  );

  it.effect("cancels shutdown and releases the panel if the renderer never acknowledges", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* DesktopCaptureShutdown.DesktopCaptureShutdown;
        const requested = yield* Deferred.make<string>();
        const released = yield* Deferred.make<string | null>();
        yield* capture.register({
          request: (id) => Deferred.succeed(requested, id).pipe(Effect.as(true)),
          release: (error) => Deferred.succeed(released, error).pipe(Effect.asVoid),
        });
        const flushing = yield* capture.flush.pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(requested);
        yield* TestClock.adjust("30 seconds");
        const error = yield* Fiber.join(flushing);
        assert.equal(error._tag, "DesktopCaptureFlushError");
        assert.equal(yield* Deferred.await(released), error.message);
      }),
    ).pipe(Effect.provide(Layer.merge(DesktopCaptureShutdown.layer, TestClock.layer()))),
  );
});
