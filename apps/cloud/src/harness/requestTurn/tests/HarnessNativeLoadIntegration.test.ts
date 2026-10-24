import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import {
  completeNativeTurn,
  integration,
  isNativeTurnStart,
  layer,
} from "./nativeLoadIntegrationFixture.ts";
import { runId } from "../../runStore/tests/fixture.ts";

describe("request-turn native load through the real Codex binding", () => {
  it.effect.each(["thread/start", "thread/resume"] as const)(
    "fences held %s on replacement and calibrates one successful start and checkpoint",
    (setup) =>
      Effect.gen(function* () {
        const setupEntered = Promise.withResolvers<void>();
        const releaseSetup = Promise.withResolvers<void>();
        const held = yield* integration(setup, async (method) => {
          if (method === setup) {
            setupEntered.resolve();
            await releaseSetup.promise;
          }
        });
        const pending = yield* held.run.pipe(Effect.result, Effect.forkScoped);
        const reachedSetup = yield* Effect.raceFirst(
          Effect.promise(() => setupEntered.promise).pipe(Effect.as("native-setup")),
          Fiber.await(pending).pipe(Effect.as("request-finished")),
        );
        expect(reachedSetup).toBe("native-setup");

        const replaced = yield* held.call(install(2));
        expect(replaced.snapshot.requests?.entries[0]?.status).toBe("indeterminate");
        releaseSetup.resolve();
        expect(Result.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(held.peer.sent).toEqual([setup]);
        expect(held.driver.publications.some((item) => item.kind === "turn.started")).toBe(false);
        expect(held.driver.exports).toHaveLength(0);
        expect(held.driver.terminals).toHaveLength(0);
        const fenced = yield* held.call({ type: "read", runId });
        expect(fenced.snapshot.requests?.entries[0]?.finish).toBe(null);
        yield* held.facet.dispose;

        const setupEnteredForCalibration = Promise.withResolvers<void>();
        const releaseSetupForCalibration = Promise.withResolvers<void>();
        const turnStartEntered = Promise.withResolvers<void>();
        const releaseTurnStart = Promise.withResolvers<void>();
        const calibrated = yield* integration(setup, async (method) => {
          if (method === setup) {
            setupEnteredForCalibration.resolve();
            await releaseSetupForCalibration.promise;
          }
          if (method === "turn/start") {
            turnStartEntered.resolve();
            await releaseTurnStart.promise;
          }
        });
        const publishedStart = yield* Deferred.make<void>();
        calibrated.driver.setPublication((item) =>
          item.kind === "provider" && isNativeTurnStart(item.event)
            ? Deferred.succeed(publishedStart, undefined)
            : Effect.void,
        );
        const running = yield* calibrated.run.pipe(Effect.result, Effect.forkScoped);
        const calibrationReachedSetup = yield* Effect.raceFirst(
          Effect.promise(() => setupEnteredForCalibration.promise).pipe(Effect.as("native-setup")),
          Fiber.await(running).pipe(Effect.as("request-finished")),
        );
        expect(calibrationReachedSetup).toBe("native-setup");
        releaseSetupForCalibration.resolve();
        const turnWasSent = yield* Effect.raceFirst(
          Effect.promise(() => turnStartEntered.promise).pipe(Effect.as("turn-start")),
          Fiber.await(running).pipe(Effect.as("request-finished")),
        );
        expect(turnWasSent).toBe("turn-start");
        releaseTurnStart.resolve();
        yield* Deferred.await(publishedStart);

        yield* completeNativeTurn(calibrated.peer, "preinitialized-turn");
        const completed = yield* Fiber.join(running);
        if (Result.isFailure(completed)) return yield* Effect.fail(completed.failure);
        expect(completed.success.action).toBe("committed");
        expect(completed.success.snapshot.requests?.entries[0]?.status).toBe("completed");
        expect(completed.success.snapshot.requests?.entries[0]?.finish?.status).toBe("completed");
        expect(calibrated.peer.sent.filter((method) => method !== "thread/read")).toEqual([
          setup,
          "turn/start",
        ]);
        expect(calibrated.launchCount).toBe(1);
        expect(calibrated.driver.exports).toHaveLength(1);
        expect(calibrated.driver.terminals).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
