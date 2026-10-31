import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";

import type { HarnessTurnStage } from "../HarnessTurnProgress.ts";

export interface HarnessTurnStageDeadlineOptions {
  readonly stageIdleMs: number;
  readonly totalMs: number;
}

export interface HarnessTurnStageDeadline {
  readonly hasSeen: (stage: HarnessTurnStage) => boolean;
  /** Call only after both the event and its stage reference have been durably published. */
  readonly accept: (stage: HarnessTurnStage) => Effect.Effect<boolean>;
  /** Fails after stage inactivity or at the non-resettable hard deadline. */
  readonly timeout: Effect.Effect<never, HarnessRequestFacetError>;
}

const formatDuration = (milliseconds: number) =>
  milliseconds % 1_000 === 0 ? `${milliseconds / 1_000} seconds` : `${milliseconds} ms`;

export const createHarnessTurnStageDeadline = (
  onTimeout: () => void,
  options?: HarnessTurnStageDeadlineOptions,
): Effect.Effect<HarnessTurnStageDeadline, HarnessRequestFacetError> => {
  if (
    options !== undefined &&
    (!Number.isFinite(options.stageIdleMs) ||
      options.stageIdleMs <= 0 ||
      !Number.isFinite(options.totalMs) ||
      options.totalMs <= 0)
  )
    return Effect.fail(
      new HarnessRequestFacetError("Harness turn deadline values must be positive and finite."),
    );

  return Effect.gen(function* () {
    const startedAt = options === undefined ? undefined : yield* Clock.currentTimeMillis;
    const hardDeadline = startedAt === undefined ? undefined : startedAt + options!.totalMs;
    let currentStage: HarnessTurnStage = "native-setup";
    let stageStartedAt = startedAt;
    const seen = new Set<HarnessTurnStage>(["native-setup"]);
    let changed = Deferred.makeUnsafe<void>();

    const wake = () => {
      const previous = changed;
      changed = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(previous, Effect.void);
    };

    const stageTimeout = (stage: HarnessTurnStage) =>
      new HarnessRequestFacetError(
        stage === "native-setup"
          ? `Harness turn timed out during native-setup before its first milestone (${formatDuration(options!.stageIdleMs)} inactivity); last accepted milestone: none.`
          : `Harness turn timed out during stage '${stage}' after ${formatDuration(options!.stageIdleMs)} inactivity, waiting for the next milestone; last accepted milestone: '${stage}'.`,
      );
    const hardTimeout = (stage: HarnessTurnStage) =>
      new HarnessRequestFacetError(
        stage === "native-setup"
          ? `Harness turn exceeded its ${formatDuration(options!.totalMs)} overall deadline during native-setup; last accepted milestone: none.`
          : `Harness turn exceeded its ${formatDuration(options!.totalMs)} overall deadline during stage '${stage}'; last accepted milestone: '${stage}'.`,
      );

    const timeout =
      options === undefined
        ? Effect.never
        : Effect.gen(function* () {
            while (true) {
              const now = yield* Clock.currentTimeMillis;
              const stageDeadline = stageStartedAt! + options.stageIdleMs;
              if (now >= hardDeadline!) {
                // raceFirst awaits loser cleanup, so revoke access before reporting the timeout.
                yield* Effect.sync(onTimeout);
                return yield* Effect.fail(hardTimeout(currentStage));
              }
              if (now >= stageDeadline) {
                yield* Effect.sync(onTimeout);
                return yield* Effect.fail(stageTimeout(currentStage));
              }

              const notification = changed;
              const nextDeadline = Math.min(hardDeadline!, stageDeadline);
              yield* Effect.raceFirst(
                Effect.sleep(nextDeadline - now),
                Deferred.await(notification),
              );
            }
          });

    return {
      hasSeen: (stage) => seen.has(stage),
      accept: (stage) =>
        Effect.gen(function* () {
          if (options !== undefined) {
            const now = yield* Clock.currentTimeMillis;
            if (now >= hardDeadline! || now >= stageStartedAt! + options.stageIdleMs) {
              wake();
              return false;
            }
          }
          if (seen.has(stage)) return false;
          seen.add(stage);
          currentStage = stage;
          if (options !== undefined) {
            stageStartedAt = yield* Clock.currentTimeMillis;
            wake();
          }
          return true;
        }),
      timeout,
    };
  });
};
