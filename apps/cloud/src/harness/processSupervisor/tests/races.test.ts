import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { describe, expect, it } from "@effect/vitest";
import { HarnessProcessSupervisorPortError } from "../../HarnessProcessSupervisor.ts";
import { fixture, turn } from "./ports.fixture.ts";
import { resumeResult } from "./cResume.fixture.ts";

describe("HarnessProcessSupervisor concurrent admission and publication", () => {
  it.effect.each([true, false])(
    "buffers a reset before C replies and requires confirmed identity, matching=%s",
    (matching) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const entered = yield* Deferred.make<void>();
        const reply = yield* Deferred.make<void>();
        let calls = 0;
        const supervisor = yield* f.open({
          caller: {
            ...f.caller,
            processResume: {
              resume: (input) =>
                Effect.gen(function* () {
                  calls++;
                  if (calls === 1) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(reply);
                  }
                  return resumeResult(input, f.options.initial.checkpoint);
                }),
            },
          },
        });
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        const ordinary = yield* f.next;
        yield* f.send(ordinary.execution, "initial");
        yield* Deferred.await(entered);
        yield* Queue.offer(f.signals, {
          eventId: "fresh-before-reply",
          kind: "exceededMemory",
          nativeSessionId: ordinary.execution.checkpoint.nativeSessionId,
          turnId: turn.turnId,
          incarnation: { generation: 2, facetNonce: matching ? "facet-2" : "wrong-facet" },
        });
        yield* f.storage.until((state) =>
          state.signals.some((receipt) => receipt.disposition === "pending"),
        );
        expect(calls).toBe(1);
        yield* Deferred.succeed(reply, undefined);
        const native = yield* f.next;
        expect(native.execution.incarnation.generation).toBe(matching ? 3 : 2);
        expect(f.turns.map((execution) => execution.incarnation.generation)).toEqual([
          1,
          matching ? 3 : 2,
        ]);
        expect(yield* supervisor.snapshot).toMatchObject({ failedRestarts: matching ? 1 : 0 });
        yield* f.finish(native);
        expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Completed" });
        expect(calls).toBe(matching ? 2 : 1);
      }),
  );

  it.effect("does not overwrite a committed conflict with a concurrent turn completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const conflictWritten = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();
      const supervisor = yield* f.open({
        store: {
          read: f.storage.store.read,
          compareAndSet: (revision, next) =>
            Effect.gen(function* () {
              const committed = yield* f.storage.store.compareAndSet(revision, next);
              if (next.blocker?.reason === "conflicting-id") {
                yield* Deferred.succeed(conflictWritten, undefined);
                yield* Deferred.await(reply);
              }
              return committed;
            }),
        },
      });
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* f.send(ordinary.execution, "reused-id");
      const resumed = yield* f.next;
      yield* f.send(ordinary.execution, "reused-id", "exceededMemory");
      yield* Deferred.await(conflictWritten);
      yield* f.finish(resumed);
      yield* Deferred.await(resumed.joined);
      yield* Deferred.succeed(reply, undefined);
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "conflicting-id" });
      expect(f.storage.read()?.phase).toBe("blocked");
      expect(f.storage.read()?.turns[0]?.result).toBeNull();
    }),
  );

  it.effect("rejected request IDs remain idempotent after the active turn completes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const native = yield* f.next;
      const deniedTurn = { ...turn, requestId: "busy-request", turnId: "next-turn" };
      const rejected = yield* supervisor.run(deniedTurn);
      const retryRequest = { requestId: "busy-retry", turnId: turn.turnId };
      const rejectedRetry = yield* supervisor.retry(retryRequest);
      yield* f.finish(native);
      yield* Fiber.join(running);
      const replacement = yield* f.open();
      expect(yield* replacement.run(deniedTurn)).toEqual(rejected);
      expect(yield* replacement.retry(retryRequest)).toEqual(rejectedRetry);
      expect(yield* replacement.run({ ...deniedTurn, inputSha256: "e".repeat(64) })).toMatchObject({
        reason: "conflicting-id",
      });
      expect(
        yield* replacement.retry({ requestId: deniedTurn.requestId, turnId: turn.turnId }),
      ).toMatchObject({ reason: "conflicting-id" });
      expect(f.turns).toHaveLength(1);
    }),
  );

  it.effect("a replaced idle controller cannot admit a turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const stale = yield* f.open();
      const owner = yield* f.open();
      expect(yield* stale.run(turn).pipe(Effect.result)).toMatchObject({
        failure: { reason: "stale-owner" },
      });
      const running = yield* owner.run(turn).pipe(Effect.forkScoped);
      yield* f.finish(yield* f.next);
      expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Completed" });
      expect(f.turns).toHaveLength(1);
    }),
  );

  it.effect("ingress failure parks the turn without inventing a reset", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const failed = yield* Deferred.make<never, HarnessProcessSupervisorPortError>();
      const supervisor = yield* f.open({
        ingress: {
          subscribe: Effect.succeed({ take: Deferred.await(failed) }),
        },
      });
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const native = yield* f.next;
      yield* Deferred.fail(failed, new HarnessProcessSupervisorPortError({ port: "ingress" }));
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "ingress-failed" });
      yield* Deferred.await(native.joined);
      expect(f.resumes).toHaveLength(0);
    }),
  );
});
