import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type { RunId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export interface RunnerPreparationState {
  readonly turn: Pick<RunnerTurn, "runId" | "preparationGeneration">;
  status: "loading" | "running" | "stopped";
  preparationFiber: Fiber.Fiber<void> | null;
  readonly handoff: Deferred.Deferred<void>;
  handedOff: boolean;
}

export const makeRunnerPreparations = <T extends RunnerPreparationState>(input: {
  readonly find: (runId: RunId) => T | undefined;
  readonly forget: (runId: RunId, state: T) => void;
  readonly taken: Set<RunId>;
  readonly emit: (item: RunnerItem) => Effect.Effect<void>;
  readonly scope: Scope.Scope;
}) => {
  const generations = new Map<RunId, number>();
  const cancelled = new Map<RunId, number>();
  const handedOff = new Map<RunId, number>();

  const launch = (state: T, run: Effect.Effect<void>) =>
    Effect.gen(function* () {
      if (state.status === "stopped") return;
      // The child cannot touch the checkout before cancellation can join its fiber.
      const registered = yield* Deferred.make<void>();
      state.preparationFiber = yield* Deferred.await(registered).pipe(
        Effect.andThen(Effect.suspend(() => (state.status === "stopped" ? Effect.void : run))),
        Effect.forkIn(input.scope),
      );
      yield* Deferred.succeed(registered, undefined);
    });

  const stop = (state: T) => {
    state.status = "stopped";
    return Effect.gen(function* () {
      if (state.preparationFiber !== null) yield* Fiber.interrupt(state.preparationFiber);
      input.forget(state.turn.runId, state);
      const generation = state.turn.preparationGeneration;
      if (generation !== undefined) {
        cancelled.set(state.turn.runId, generation);
        yield* input.emit({
          kind: "preparation.cancelled",
          runId: state.turn.runId,
          preparationGeneration: generation,
        });
      }
    }).pipe(Effect.forkIn(input.scope), Effect.asVoid);
  };

  const take = (turn: RunnerTurn) => {
    const previous = generations.get(turn.runId);
    if (
      turn.preparationGeneration === undefined
        ? input.taken.has(turn.runId)
        : previous !== undefined && turn.preparationGeneration <= previous
    )
      return false;
    if (input.find(turn.runId) !== undefined) return false;
    input.taken.add(turn.runId);
    if (turn.preparationGeneration !== undefined)
      generations.set(turn.runId, turn.preparationGeneration);
    return true;
  };

  const handoff = (runId: RunId, generation: number) =>
    Effect.suspend(() => {
      const state = input.find(runId);
      if (state?.turn.preparationGeneration !== generation || state.status !== "loading")
        return Effect.void;
      state.handedOff = true;
      handedOff.set(runId, generation);
      return Effect.asVoid(Deferred.succeed(state.handoff, undefined));
    });

  const cancel = (runId: RunId, generation: number) =>
    Effect.suspend(() => {
      const state = input.find(runId);
      const report = input.emit({
        kind: "preparation.cancelled",
        runId,
        preparationGeneration: generation,
      });
      if (state === undefined) {
        if (cancelled.get(runId) === generation) return report;
        if ((generations.get(runId) ?? 0) > generation || handedOff.get(runId) === generation)
          return Effect.void;
        // A held turn may not have arrived yet. Keep a tombstone so its delayed
        // turn.start cannot restart the attempt after cancellation was acknowledged.
        generations.set(runId, generation);
        cancelled.set(runId, generation);
        input.taken.add(runId);
        return report;
      }
      if (
        state.turn.preparationGeneration !== generation ||
        state.status !== "loading" ||
        state.handedOff
      )
        return Effect.void;
      return stop(state);
    });

  return {
    take,
    launch,
    handoff,
    cancel,
    interrupt: (state: T) => stop(state),
    isCurrent: (runId: RunId, generation: number) => generations.get(runId) === generation,
    taken: Effect.sync(() =>
      [...generations].map(([runId, preparationGeneration]) => ({ runId, preparationGeneration })),
    ),
  };
};
