import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeRunnerPreparations, type RunnerPreparationState } from "./RunnerPreparations.ts";

const runId = RunId.make("preparation-race");

const fixture = Effect.gen(function* () {
  const stopped = yield* Deferred.make<void>();
  const state: RunnerPreparationState = {
    turn: { runId, preparationGeneration: 1 },
    status: "loading",
    preparationFiber: null,
    handoff: yield* Deferred.make<void>(),
    handedOff: false,
  };
  let current: RunnerPreparationState | undefined = state;
  const preparations = makeRunnerPreparations({
    find: () => current,
    forget: () => {
      current = undefined;
    },
    taken: new Set<RunId>(),
    scope: yield* Effect.scope,
    emit: (item) =>
      item.kind === "preparation.cancelled"
        ? Effect.asVoid(Deferred.succeed(stopped, undefined))
        : Effect.void,
  });
  return { state, stopped, preparations };
});

describe("preparation launch and stop ordering", () => {
  it.effect(
    "a confirmed stop between recording a turn and forking it prevents checkout from ever starting",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { state, stopped, preparations } = yield* fixture;
          let checkouts = 0;
          expect(state.preparationFiber).toBeNull();
          yield* preparations.cancel(runId, 1);
          yield* Deferred.await(stopped);
          yield* preparations.launch(
            state,
            Effect.sync(() => {
              checkouts += 1;
            }),
          );
          expect(checkouts).toBe(0);
          expect(state.preparationFiber).toBeNull();
        }),
      ),
  );

  it.effect(
    "registers a child before it can prepare and confirms cancellation only after that child stops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { state, stopped, preparations } = yield* fixture;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let finished = false;
          yield* preparations.launch(
            state,
            Effect.gen(function* () {
              expect(state.preparationFiber).not.toBeNull();
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release).pipe(Effect.uninterruptible);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  finished = true;
                }),
              ),
            ),
          );
          yield* Deferred.await(entered);
          yield* preparations.cancel(runId, 1);
          expect(yield* Deferred.isDone(stopped)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(stopped);
          expect(finished).toBe(true);
          expect(state.status).toBe("stopped");
        }),
      ),
  );
});
