import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { describe, expect, it } from "@effect/vitest";
import { fixture, initial, turn } from "./ports.fixture.ts";

describe("HarnessProcessSupervisor signal authority", () => {
  it.effect(
    "ignores stale session, turn, generation and nonce signals without spending the budget",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const supervisor = yield* f.open();
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        const native = yield* f.next;
        const signal = {
          eventId: "event",
          kind: "reset" as const,
          nativeSessionId: initial.checkpoint.nativeSessionId,
          turnId: turn.turnId,
          incarnation: initial.incarnation,
        };
        const stale = [
          { ...signal, eventId: "wrong-session", nativeSessionId: "wrong" },
          { ...signal, eventId: "wrong-turn", turnId: "wrong" },
          {
            ...signal,
            eventId: "wrong-generation",
            incarnation: { ...initial.incarnation, generation: 9 },
          },
          {
            ...signal,
            eventId: "wrong-publisher",
            incarnation: { ...initial.incarnation, facetNonce: "wrong" },
          },
        ];
        yield* Queue.offerAll(f.signals, stale);
        const stored = yield* f.storage.until((state) => state.signals.length === 4);
        expect(stored.signals.map((receipt) => receipt.disposition)).toEqual([
          "stale",
          "stale",
          "stale",
          "stale",
        ]);
        expect(stored.failedRestarts).toBe(0);
        expect(f.resumes).toHaveLength(0);
        yield* f.finish(native);
        expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Completed" });
      }),
  );

  it.effect("deduplicates a signal even after the incarnation has changed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* f.send(ordinary.execution, "same-event");
      const resumed = yield* f.next;
      yield* f.send(ordinary.execution, "same-event");
      yield* f.send(ordinary.execution, "barrier-stale");
      const stored = yield* f.storage.until((state) => state.signals.length === 2);
      expect(stored.failedRestarts).toBe(0);
      expect(f.resumes).toHaveLength(1);
      yield* f.finish(resumed);
      expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Completed" });
    }),
  );

  it.effect("parks a conflicting reused signal id and joins the active turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* f.send(ordinary.execution, "same-event");
      const resumed = yield* f.next;
      yield* f.send(ordinary.execution, "same-event", "exceededMemory");
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "conflicting-id" });
      yield* Deferred.await(resumed.joined);
      expect(f.resumes).toHaveLength(1);
      expect(f.subscriptions()).toEqual({ acquired: 1, released: 1 });
    }),
  );

  it.effect("coalesces two different observations of the same failed incarnation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* f.send(ordinary.execution, "reset");
      yield* f.send(ordinary.execution, "memory", "exceededMemory");
      const resumed = yield* f.next;
      const state = yield* f.storage.until((value) => value.signals.length === 2);
      expect(state.signals.filter((receipt) => receipt.disposition === "accepted")).toHaveLength(1);
      expect(f.resumes).toHaveLength(1);
      yield* f.finish(resumed);
      yield* Fiber.join(running);
    }),
  );
});
