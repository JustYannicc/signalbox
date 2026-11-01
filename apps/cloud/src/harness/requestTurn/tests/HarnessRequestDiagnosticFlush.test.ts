import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { createHarnessRequestTurn } from "../../HarnessRequestTurn.ts";
import { requestFixture } from "./fixture.ts";

const deadline = { stageIdleMs: 45_000, totalMs: 180_000 };

describe("Harness request diagnostic publication", () => {
  it.effect(
    "revokes failed request access but waits for diagnostic persistence before replying",
    () =>
      Effect.gen(function* () {
        const f = yield* requestFixture;
        const flushing = yield* Deferred.make<void>();
        const published = yield* Deferred.make<void>();
        const context = f.context("request-diagnostic-flush");
        const runtime = yield* createHarnessRequestTurn({
          ...f.options,
          deadline,
          flushDiagnostics: Deferred.succeed(flushing, undefined).pipe(
            Effect.andThen(Deferred.await(published)),
          ),
        })(f.initial, context);
        const running = yield* runtime
          .run(f.firstInput, context)
          .pipe(Effect.result, Effect.forkScoped);
        yield* f.instance.adapter.nextStart;
        yield* TestClock.adjust(46_000);
        yield* Deferred.await(flushing);
        expect(running.pollUnsafe()).toBeUndefined();
        const access = yield* Effect.tryPromise({
          try: () => f.harness.modelTransport(new Request("https://model.invalid/after-timeout")),
          catch: () => new HarnessRequestFacetError("Request access was revoked."),
        }).pipe(Effect.result);
        expect(Result.isFailure(access)).toBe(true);
        yield* Deferred.succeed(published, undefined);
        const result = yield* Fiber.join(running);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.message).toContain("native-setup");
      }).pipe(Effect.scoped),
  );

  it.effect("retains both the original timeout and a diagnostic publication failure", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const context = f.context("request-diagnostic-flush-failed");
      const runtime = yield* createHarnessRequestTurn({
        ...f.options,
        deadline,
        flushDiagnostics: Effect.fail(new HarnessRequestFacetError("Capture publication failed.")),
      })(f.initial, context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      yield* TestClock.adjust(46_000);
      const exit = yield* Fiber.join(running);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const cause = Cause.pretty(exit.cause);
        expect(cause).toContain("native-setup");
        expect(cause).toContain("Capture publication failed.");
      }
    }).pipe(Effect.scoped),
  );
});
