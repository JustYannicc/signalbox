import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";
import { HarnessProcessSupervisorPortError } from "../../HarnessProcessSupervisor.ts";
import { fixture, initial, turn } from "./ports.fixture.ts";
import { resumeResult } from "./cResume.fixture.ts";

describe("HarnessProcessSupervisor durable ownership and cancellation", () => {
  it.effect("scope disposal joins the turn and subscription without explicit close", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const lifetime = yield* Scope.make();
      const supervisor = yield* f.open().pipe(Scope.provide(lifetime));
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const native = yield* f.next;
      yield* Scope.close(lifetime, Exit.void);
      yield* Deferred.await(native.joined);
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "cancelled" });
      expect(f.subscriptions()).toEqual({ acquired: 1, released: 1 });
      expect(f.resumes).toHaveLength(0);
    }),
  );

  it.effect("rejects malformed persisted records before claiming or executing", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const opened = yield* f
        .open({ store: { ...f.storage.store, read: Effect.succeed({ phase: "running" }) } })
        .pipe(Effect.result);
      expect(opened).toMatchObject({ failure: { reason: "invalid-store" } });
      expect(f.storage.writes).toHaveLength(0);
      expect(f.turns).toHaveLength(0);
    }),
  );

  it.effect("shares duplicate in-flight requests without sending the input twice", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const first = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const native = yield* f.next;
      const duplicate = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      expect(yield* supervisor.run({ ...turn, turnId: "wrong" })).toMatchObject({
        reason: "conflicting-id",
      });
      yield* f.finish(native);
      expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(duplicate));
      expect(f.turns).toHaveLength(1);
    }),
  );

  it.effect("reconstruction fences a pending C call and rejects its late publication", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();
      let calls = 0;
      const first = yield* f.open({
        caller: {
          ...f.caller,
          processResume: {
            resume: (input) =>
              Effect.gen(function* () {
                calls++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(reply);
                return resumeResult(input, initial.checkpoint);
              }),
          },
        },
      });
      const running = yield* first.run(turn).pipe(Effect.forkScoped);
      yield* f.send((yield* f.next).execution, "reset");
      yield* Deferred.await(entered);
      const intent = f.storage.read();
      expect(intent?.phase).toBe("resuming");
      const replacement = yield* f.open();
      const blocked = yield* replacement.run(turn);
      expect(blocked).toMatchObject({
        reason: "effect-uncertain",
        operationId: intent?.operationId,
      });
      expect(yield* replacement.retry({ requestId: "retry", turnId: turn.turnId })).toEqual(
        blocked,
      );
      yield* Deferred.succeed(reply, undefined);
      expect(yield* Fiber.join(running)).toMatchObject({
        reason: "stale-owner",
        recovery: "new-owner",
      });
      expect(f.storage.read()).toMatchObject({
        phase: "blocked",
        incarnation: initial.incarnation,
        attempt: 1,
      });
      expect(f.turns).toHaveLength(1);
      expect(calls).toBe(1);
    }),
  );

  it.effect("reconstruction during a turn cannot replay it or accept the old completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const old = yield* f.open();
      const running = yield* old.run(turn).pipe(Effect.forkScoped);
      const native = yield* f.next;
      const replacement = yield* f.open();
      expect(yield* replacement.run(turn)).toMatchObject({ reason: "effect-uncertain" });
      yield* f.finish(native);
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "stale-owner" });
      expect(f.storage.read()?.checkpoint).toEqual(initial.checkpoint);
      expect(f.turns).toHaveLength(1);
    }),
  );

  it.effect("close waits for owned C finalization and then releases the subscription", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      let calls = 0;
      const supervisor = yield* f.open({
        caller: {
          ...f.caller,
          processResume: {
            resume: () =>
              Effect.gen(function* () {
                calls++;
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.ensuring(
                  Deferred.succeed(stopping, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              ),
          },
        },
      });
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* f.send(ordinary.execution, "reset");
      yield* Deferred.await(entered);
      const closing = yield* supervisor.close.pipe(
        Effect.andThen(Deferred.succeed(closed, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(stopping);
      expect(Deferred.isDoneUnsafe(closed)).toBe(false);
      expect(f.storage.read()).toMatchObject({
        phase: "blocked",
        blocker: { reason: "cancelled", recovery: "reconcile" },
      });
      yield* f.send(ordinary.execution, "after-cancel");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      expect(yield* Fiber.join(running)).toMatchObject({ reason: "cancelled" });
      expect(calls).toBe(1);
      expect(f.subscriptions()).toEqual({ acquired: 1, released: 1 });
      expect(yield* supervisor.run(turn).pipe(Effect.result)).toMatchObject({
        failure: { reason: "closed" },
      });
      const replacement = yield* f.open();
      expect(yield* replacement.retry({ requestId: "retry", turnId: turn.turnId })).toMatchObject({
        reason: "cancelled",
      });
    }),
  );

  it.effect("interrupting run joins the active turn and prevents a queued reset", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const supervisor = yield* f.open();
      const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
      const ordinary = yield* f.next;
      yield* Fiber.interrupt(running);
      yield* Deferred.await(ordinary.joined);
      yield* f.send(ordinary.execution, "late-reset");
      expect(f.resumes).toHaveLength(0);
      expect(f.subscriptions()).toEqual({ acquired: 1, released: 1 });
      expect(f.storage.read()).toMatchObject({
        phase: "blocked",
        blocker: { reason: "cancelled" },
      });
    }),
  );

  it.effect(
    "a lost store reply after C succeeds leaves intent unresolved and is not replayed",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const supervisor = yield* f.open({
          store: {
            read: f.storage.store.read,
            compareAndSet: (revision, next) =>
              next.trace.at(-1)?.fact === "resumed"
                ? Effect.fail(new HarnessProcessSupervisorPortError({ port: "store" }))
                : f.storage.store.compareAndSet(revision, next),
          },
        });
        const running = yield* supervisor.run(turn).pipe(Effect.forkScoped);
        yield* f.send((yield* f.next).execution, "reset");
        expect(yield* Fiber.join(running)).toMatchObject({ reason: "effect-uncertain" });
        const replacement = yield* f.open();
        expect(yield* replacement.run(turn)).toMatchObject({ reason: "effect-uncertain" });
        expect(f.resumes).toHaveLength(1);
        expect(f.turns).toHaveLength(1);
      }),
  );
});
