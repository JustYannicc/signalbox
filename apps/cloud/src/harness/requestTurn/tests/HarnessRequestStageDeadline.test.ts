import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import {
  createHarnessRequestTurn,
  createHarnessTurnStageDeadline,
} from "../../HarnessRequestTurn.ts";
import {
  encodeHarnessTurnMilestone,
  HARNESS_TURN_MILESTONE_TYPE,
  parseHarnessTurnMilestone,
} from "../../HarnessTurnProgress.ts";
import type { HarnessRuntimeReporter } from "../../HarnessProcessLifetime.ts";
import { requestFixture } from "./fixture.ts";

const qualificationDeadline = { stageIdleMs: 45_000, totalMs: 180_000 } as const;

describe("Harness request turn stage deadline", () => {
  it.effect.each([false, true] as const)(
    "fails a native turn that stalls before its first milestone (start pending: %s)",
    (startPending) =>
      Effect.gen(function* () {
        const f = yield* requestFixture;
        if (startPending) f.instance.adapter.setStartGate(Effect.never);
        const context = f.context("request-stage-timeout");
        const runtime = yield* createHarnessRequestTurn({
          ...f.options,
          deadline: qualificationDeadline,
        })(f.initial, context);
        const running = yield* runtime
          .run(f.firstInput, context)
          .pipe(Effect.result, Effect.forkScoped);

        yield* f.instance.adapter.nextStart;
        yield* TestClock.adjust(46_000);

        const settled = running.pollUnsafe();
        expect(settled).toBeDefined();
        if (settled !== undefined) {
          expect(Exit.isSuccess(settled)).toBe(true);
          if (Exit.isSuccess(settled)) {
            expect(Result.isFailure(settled.value)).toBe(true);
            if (Result.isFailure(settled.value)) {
              expect(settled.value.failure).toBeInstanceOf(HarnessRequestFacetError);
              expect(settled.value.failure.message).toContain("native-setup");
              expect(settled.value.failure.message).toContain("last accepted milestone: none");
            }
          }
        }

        expect(f.signals[0]?.aborted).toBe(startPending);
        expect(f.exports).toHaveLength(0);
        expect(f.terminals).toHaveLength(0);
        const postTimeoutAccess = yield* Effect.tryPromise({
          try: () => f.harness.modelTransport(new Request("https://model.invalid/after-timeout")),
          catch: () => new HarnessRequestFacetError("Request access was revoked."),
        }).pipe(Effect.result);
        expect(Result.isFailure(postTimeoutAccess)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("publishes a real adapter milestone and renews inactivity after durable progress", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      let report: HarnessRuntimeReporter["turnMilestone"];
      f.setHost({
        buildRuntime: (input) =>
          f.instance.options.buildRuntime(input).pipe(
            Effect.map((binding) => ({
              ...binding,
              factory: {
                open: (supplied, reporter) =>
                  Effect.suspend(() => {
                    report = reporter.turnMilestone;
                    return binding.factory.open(supplied, reporter);
                  }),
              },
            })),
          ),
      });
      const published = yield* Deferred.make<void>();
      const current = f.context("request-published-stage");
      const context = {
        ...current,
        progress: (kind: string, reference: Parameters<typeof current.progress>[1]) =>
          current
            .progress(kind, reference)
            .pipe(
              Effect.andThen(
                kind === "stage:sdk-initializing"
                  ? Deferred.succeed(published, undefined)
                  : Effect.void,
              ),
            ),
      };
      const runtime = yield* createHarnessRequestTurn({
        ...f.options,
        deadline: qualificationDeadline,
      })(f.initial, context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.result, Effect.forkScoped);
      yield* f.instance.adapter.nextStart;
      expect(report).toBeTypeOf("function");
      yield* TestClock.adjust(44_000);
      report!("sdk-initializing");
      yield* Deferred.await(published);
      expect(
        f.publications.some(
          (item) =>
            item.kind === "log" && parseHarnessTurnMilestone(item.message) === "sdk-initializing",
        ),
      ).toBe(true);
      yield* TestClock.adjust(44_000);
      expect(running.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1_000);
      const settled = yield* Fiber.join(running);
      expect(Result.isFailure(settled)).toBe(true);
      if (Result.isFailure(settled)) expect(settled.failure.message).toContain("sdk-initializing");
    }).pipe(Effect.scoped),
  );

  it.effect.each(["event", "progress"] as const)(
    "does not renew inactivity while durable %s publication is stalled",
    (boundary) =>
      Effect.gen(function* () {
        const f = yield* requestFixture;
        let report: HarnessRuntimeReporter["turnMilestone"];
        f.setHost({
          buildRuntime: (input) =>
            f.instance.options.buildRuntime(input).pipe(
              Effect.map((binding) => ({
                ...binding,
                factory: {
                  open: (supplied, reporter) =>
                    Effect.suspend(() => {
                      report = reporter.turnMilestone;
                      return binding.factory.open(supplied, reporter);
                    }),
                },
              })),
            ),
        });
        const blocked = yield* Deferred.make<void>();
        if (boundary === "event")
          f.setPublication((item) =>
            item.kind === "log"
              ? Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          );
        const current = f.context(`request-stalled-${boundary}`);
        const context = {
          ...current,
          progress: (kind: string, reference: Parameters<typeof current.progress>[1]) =>
            boundary === "progress" && kind === "stage:sdk-initializing"
              ? Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))
              : current.progress(kind, reference),
        };
        const runtime = yield* createHarnessRequestTurn({
          ...f.options,
          deadline: qualificationDeadline,
        })(f.initial, context);
        const running = yield* runtime
          .run(f.firstInput, context)
          .pipe(Effect.result, Effect.forkScoped);
        yield* f.instance.adapter.nextStart;
        yield* TestClock.adjust(40_000);
        report!("sdk-initializing");
        yield* Deferred.await(blocked);
        yield* TestClock.adjust(5_000);
        const result = yield* Fiber.join(running);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.message).toContain("last accepted milestone: none");
        expect(f.exports).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect("leaves ordinary turns unbounded when no qualification envelope is supplied", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const context = f.context("request-without-envelope");
      const runtime = yield* f.open(context);
      const running = yield* runtime
        .run(f.firstInput, context)
        .pipe(Effect.result, Effect.forkScoped);

      yield* f.instance.adapter.nextStart;
      yield* TestClock.adjust(181_000);

      expect(running.pollUnsafe()).toBeUndefined();
      expect(f.exports).toHaveLength(0);
      expect(f.terminals).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects invalid envelopes and releases request access", () =>
    Effect.gen(function* () {
      const f = yield* requestFixture;
      const context = f.context("request-invalid-envelope");
      const runtime = yield* createHarnessRequestTurn({
        ...f.options,
        deadline: { stageIdleMs: 0, totalMs: 180_000 },
      })(f.initial, context);
      const result = yield* runtime.run(f.firstInput, context).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(HarnessRequestFacetError);
        expect(result.failure.message).toContain("positive and finite");
      }
      expect(f.instance.adapter.calls.filter((call) => call === "start")).toHaveLength(0);
      const postFailureAccess = yield* Effect.tryPromise({
        try: () => f.harness.modelTransport(new Request("https://model.invalid/invalid-envelope")),
        catch: () => new HarnessRequestFacetError("Request access was revoked."),
      }).pipe(Effect.result);
      expect(Result.isFailure(postFailureAccess)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it("accepts only bounded, exact milestone records", () => {
    expect(parseHarnessTurnMilestone(encodeHarnessTurnMilestone("sdk-initializing"))).toBe(
      "sdk-initializing",
    );
    expect(
      parseHarnessTurnMilestone(
        JSON.stringify({
          type: HARNESS_TURN_MILESTONE_TYPE,
          stage: "sdk-initializing",
          detail: "untrusted payload",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseHarnessTurnMilestone(
        JSON.stringify({ type: HARNESS_TURN_MILESTONE_TYPE, stage: "not-a-stage" }),
      ),
    ).toBeUndefined();
    expect(parseHarnessTurnMilestone("{")).toBeUndefined();
    expect(parseHarnessTurnMilestone("x".repeat(161))).toBeUndefined();
  });

  it.effect("duplicate milestones do not renew the stage inactivity deadline", () =>
    Effect.gen(function* () {
      let revoked = 0;
      const deadline = yield* createHarnessTurnStageDeadline(
        () => revoked++,
        qualificationDeadline,
      );
      expect(yield* deadline.accept("sdk-initializing")).toBe(true);
      const running = yield* deadline.timeout.pipe(Effect.result, Effect.forkScoped);

      yield* TestClock.adjust(44_000);
      expect(yield* deadline.accept("sdk-initializing")).toBe(false);
      expect(yield* deadline.accept("sdk-initializing")).toBe(false);
      expect(yield* deadline.accept("sdk-initializing")).toBe(false);
      yield* TestClock.adjust(1_000);

      const settled = running.pollUnsafe();
      expect(settled).toBeDefined();
      if (settled !== undefined) {
        expect(Exit.isSuccess(settled)).toBe(true);
        if (Exit.isSuccess(settled)) {
          expect(Result.isFailure(settled.value)).toBe(true);
          if (Result.isFailure(settled.value)) {
            expect(settled.value.failure.message).toContain("sdk-initializing");
          }
        }
      }
      expect(revoked).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("enforces the hard deadline even as unique milestones arrive", () =>
    Effect.gen(function* () {
      const deadline = yield* createHarnessTurnStageDeadline(() => {}, qualificationDeadline);
      const running = yield* deadline.timeout.pipe(Effect.result, Effect.forkScoped);

      for (const stage of [
        "sdk-initializing",
        "sdk-initialized",
        "prompt-offered",
        "model-request-sent",
      ] as const) {
        yield* TestClock.adjust(44_000);
        expect(yield* deadline.accept(stage)).toBe(true);
      }
      yield* TestClock.adjust(4_000);

      const settled = running.pollUnsafe();
      expect(settled).toBeDefined();
      if (settled !== undefined) {
        expect(Exit.isSuccess(settled)).toBe(true);
        if (Exit.isSuccess(settled)) {
          expect(Result.isFailure(settled.value)).toBe(true);
          if (Result.isFailure(settled.value)) {
            expect(settled.value.failure.message).toContain("180 seconds overall deadline");
            expect(settled.value.failure.message).toContain("model-request-sent");
          }
        }
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects deadline envelopes that are not positive finite values", () =>
    Effect.gen(function* () {
      const invalid = yield* createHarnessTurnStageDeadline(() => {}, {
        stageIdleMs: 45_000,
        totalMs: Number.POSITIVE_INFINITY,
      }).pipe(Effect.result);

      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) {
        expect(invalid.failure).toBeInstanceOf(HarnessRequestFacetError);
        expect(invalid.failure.message).toContain("positive and finite");
      }
    }),
  );
});
