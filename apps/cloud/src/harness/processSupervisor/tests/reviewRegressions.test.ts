import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "@effect/vitest";
import { fixture, initial, turn } from "./ports.fixture.ts";

describe("HarnessProcessSupervisor reset and receipt publication", () => {
  it.effect("reconciles completion selected while an accepted reset CAS reply is held", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const resetWritten = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();
      const completionSelected = yield* Deferred.make<void>();
      const supervisor = yield* f.open({
        store: {
          read: f.storage.store.read,
          compareAndSet: (revision, next) =>
            Effect.gen(function* () {
              const committed = yield* f.storage.store.compareAndSet(revision, next);
              if (next.trace.at(-1)?.fact === "signal-accepted") {
                yield* Deferred.succeed(resetWritten, undefined);
                yield* Deferred.await(reply);
              }
              return committed;
            }),
        },
      });
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* f.send(ordinary.execution, "reset-before-completion");
      yield* Deferred.await(resetWritten);
      const checkpoint = {
        ...ordinary.execution.checkpoint,
        completedTurnId: turn.turnId,
        checkpointId: "checkpoint-completed",
        manifestSha256: "c".repeat(64),
      };
      yield* Deferred.succeed(ordinary.complete, {
        turnId: turn.turnId,
        incarnation: ordinary.execution.incarnation,
        // This observes completion selection without adding a production scheduling hook.
        get checkpoint() {
          Deferred.doneUnsafe(completionSelected, Effect.void);
          return checkpoint;
        },
      });
      yield* Deferred.await(completionSelected);
      yield* Deferred.succeed(reply, undefined);
      expect(yield* Fiber.join(running)).toMatchObject({
        _tag: "Blocker",
        reason: "effect-uncertain",
        recovery: "reconcile",
      });
      const state = yield* supervisor.snapshot;
      expect(state.phase).toBe("blocked");
      expect(state.checkpoint).toEqual(initial.checkpoint);
      expect(state.signals[0]?.disposition).toBe("accepted");
      expect(state.turns[0]?.result).toBeNull();
      expect(f.resumes).toHaveLength(0);
      expect(
        yield* supervisor.run({ ...turn, requestId: "next-request", turnId: "next-turn" }),
      ).toMatchObject({ _tag: "Blocker" });
      expect(yield* supervisor.retry({ requestId: "retry", turnId: turn.turnId })).toMatchObject({
        reason: "effect-uncertain",
        recovery: "reconcile",
      });
      const reconstructed = yield* f.open();
      expect(yield* reconstructed.run(turn)).toMatchObject({ reason: "effect-uncertain" });
      expect(f.turns).toHaveLength(1);
    }),
  );

  it.effect("a prior turn collision cannot poison an accepted later request ID", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const first = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      yield* f.finish(yield* f.next);
      const originalFirst = yield* Fiber.join(first);
      const nextTurn = { ...turn, requestId: "request-2", turnId: "turn-2" };
      const second = yield* supervisor.run(nextTurn).pipe(Effect.forkScoped);
      yield* f.finish(yield* f.next);
      const original = yield* Fiber.join(second);
      expect(yield* supervisor.run({ ...turn, requestId: nextTurn.requestId })).toMatchObject({
        reason: "conflicting-id",
      });
      expect(yield* supervisor.run(nextTurn)).toEqual(original);
      expect((yield* supervisor.snapshot).denied).toEqual([]);
      yield* supervisor.close;
      const reconstructed = yield* f.open();
      expect(yield* reconstructed.run(nextTurn)).toEqual(original);
      expect(yield* reconstructed.run(turn)).toEqual(originalFirst);
      expect(f.turns).toHaveLength(2);
    }),
  );
});
