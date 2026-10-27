import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { describe, expect, it } from "@effect/vitest";
import { HarnessProcessSupervisorPortError } from "../../HarnessProcessSupervisor.ts";
import { fixture, initial, turn } from "./ports.fixture.ts";

describe("HarnessProcessSupervisor turns and restart budget", () => {
  it.effect("commits a normal turn and never replays completed or conflicting input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      expect(ordinary.execution).toEqual({ ...initial, turn, mode: "start" });
      yield* f.finish(ordinary);
      const result = yield* Fiber.join(running);
      expect(result).toMatchObject({ _tag: "Completed", turnId: turn.turnId });
      expect(yield* supervisor.run(turn)).toEqual(result);
      expect(yield* supervisor.run({ ...turn, inputSha256: "d".repeat(64) })).toMatchObject({
        reason: "conflicting-id",
      });
      expect(yield* supervisor.run({ ...turn, requestId: "changed-request" })).toMatchObject({
        reason: "conflicting-id",
      });
      expect(f.turns).toHaveLength(1);
      expect(f.resumes).toHaveLength(0);
      expect(f.subscriptions()).toEqual({ acquired: 1, released: 1 });
      const reconstructed = yield* f.open();
      expect(yield* reconstructed.run(turn)).toEqual(result);
      expect(f.turns).toHaveLength(1);
    }),
  );

  it.effect("initial reset starts restart 1; failed restarts 1/2/3 park without restart 4", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      let incarnation = yield* f.next;
      yield* f.send(incarnation.execution, "initial-reset");
      for (let attempt = 1; attempt <= 3; attempt++) {
        incarnation = yield* f.next;
        const state = yield* supervisor.snapshot;
        expect(state).toMatchObject({ attempt, failedRestarts: attempt - 1 });
        expect(incarnation.execution).toMatchObject({
          mode: "resume",
          checkpoint: initial.checkpoint,
          incarnation: { generation: attempt + 1, facetNonce: `facet-${attempt + 1}` },
        });
        yield* f.send(incarnation.execution, `failed-restart-${attempt}`, "exceededMemory");
      }
      expect(yield* Fiber.join(running)).toMatchObject({
        _tag: "Blocker",
        reason: "restart-limit",
        recovery: "retry",
        failedRestarts: 3,
      });
      expect(f.resumes).toHaveLength(3);
      expect(f.turns).toHaveLength(4);
      expect(new Set(f.intents.map((intent) => intent.operationId)).size).toBe(3);
      expect(
        f.intents.every(
          (intent) => intent.checkpoint.checkpointId === initial.checkpoint.checkpointId,
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "persists an overridden limit, reconstructs, and retries exactly once with a reset budget",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ maxFailedRestarts: 1 });
        const supervisor = yield* f.open();
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        yield* f.send((yield* f.next).execution, "reset-initial");
        yield* f.send((yield* f.next).execution, "reset-restart-1");
        expect(yield* Fiber.join(running)).toMatchObject({
          reason: "restart-limit",
          failedRestarts: 1,
        });
        yield* supervisor.close;
        const next = yield* f.open({ policy: {} });
        expect(yield* next.snapshot).toMatchObject({
          policy: { maxFailedRestarts: 1 },
          attempt: 1,
        });
        const request = { requestId: "retry-1", turnId: turn.turnId };
        const retry = yield* next.retry(request).pipe(Effect.forkScoped);
        const retryTurn = yield* f.next;
        const duplicate = yield* next.retry(request).pipe(Effect.forkScoped);
        expect(yield* next.snapshot).toMatchObject({ failedRestarts: 0, attempt: 2 });
        yield* f.finish(retryTurn);
        const completed = yield* Fiber.join(retry);
        expect(yield* Fiber.join(duplicate)).toEqual(completed);
        expect(yield* next.retry(request)).toEqual(completed);
        expect(yield* next.retry({ ...request, turnId: "wrong-turn" })).toMatchObject({
          reason: "conflicting-id",
        });
        expect(f.resumes).toHaveLength(2);
        expect(yield* next.snapshot).toMatchObject({ failedRestarts: 0, phase: "completed" });
      }),
  );

  it.effect("a successful turn ends the failure streak and advances the completed checkpoint", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const first = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      yield* f.send((yield* f.next).execution, "reset-initial");
      yield* f.send((yield* f.next).execution, "failed-restart-1");
      yield* f.finish(yield* f.next);
      expect(yield* Fiber.join(first)).toMatchObject({ _tag: "Completed" });
      const nextTurn = { ...turn, requestId: "request-2", turnId: "turn-2" };
      const second = yield* supervisor.run(nextTurn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      expect(ordinary.execution.mode).toBe("start");
      expect(ordinary.execution.checkpoint.completedTurnId).toBe(turn.turnId);
      yield* f.send(ordinary.execution, "second-initial-reset");
      const resumed = yield* f.next;
      expect(yield* supervisor.snapshot).toMatchObject({ failedRestarts: 0, attempt: 1 });
      expect(f.intents[2]?.checkpoint.checkpointId).toBe(`checkpoint-${turn.turnId}`);
      yield* f.finish(resumed);
      expect(yield* Fiber.join(second)).toMatchObject({ _tag: "Completed", turnId: "turn-2" });
    }),
  );

  it.effect.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "rejects invalid restart limit %s",
    (maxFailedRestarts) =>
      Effect.gen(function* () {
        const f = yield* fixture({ maxFailedRestarts });
        const result = yield* f.open().pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-input" } });
        expect(f.storage.writes).toHaveLength(0);
      }),
  );

  it.effect("rejects proactive activation and policy changes to a durable record", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const policy = { proactive: false as const };
      Reflect.set(policy, "proactive", true);
      expect(yield* f.open({ policy }).pipe(Effect.result)).toMatchObject({
        failure: { reason: "invalid-input" },
      });
      yield* f.open();
      expect(yield* f.open({ policy: { maxFailedRestarts: 9 } }).pipe(Effect.result)).toMatchObject(
        { failure: { reason: "policy-conflict" } },
      );
    }),
  );

  it.effect("does not interpret an ordinary runtime error as a reset", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const native = yield* f.next;
      yield* Deferred.fail(
        native.complete,
        new HarnessProcessSupervisorPortError({ port: "turn" }),
      );
      expect(yield* Fiber.join(running)).toMatchObject({
        reason: "runtime-failed",
        failedRestarts: 0,
      });
      expect(f.resumes).toHaveLength(0);
      expect(Result.isSuccess(yield* supervisor.close.pipe(Effect.result))).toBe(true);
    }),
  );
});
