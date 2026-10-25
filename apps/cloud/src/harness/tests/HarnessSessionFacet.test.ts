import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { Computer } from "../../computer/Computer.ts";
import { createHarnessSessionFacet } from "../HarnessSessionFacet.ts";
import { HarnessError } from "../Harness.ts";
import {
  forkBoundaryScheduler,
  handoffBoundaryScheduler,
  nativeAcquisition,
  ownerForkBoundaryScheduler,
  observerBoundaryScheduler,
  sessionFacetFixture,
  workerHandoffBoundaryScheduler,
} from "./sessionFacetFixture.ts";

describe("HarnessSessionFacet", () => {
  it.effect("retains caller services during native acquisition and session cleanup", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const callerValue = Context.Reference<string>("test/session-facet-caller", {
        defaultValue: () => "missing",
      });
      const observed: string[] = [];
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: (input, signal) =>
          Effect.gen(function* () {
            observed.push(yield* callerValue);
            yield* Effect.addFinalizer(() =>
              callerValue.pipe(
                Effect.tap((value) =>
                  Effect.sync(() => {
                    observed.push(value);
                  }),
                ),
                Effect.asVoid,
              ),
            );
            return yield* f.buildRuntime(input, signal);
          }),
      });
      const session = yield* facet
        .open(f.adapter.input)
        .pipe(Effect.provideService(callerValue, "caller service"));
      yield* session.dispose;
      expect(observed).toEqual(["caller service", "caller service"]);
      expect(f.cleaned).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "runs through Harness and reopens its checkpoint on the same Computer and release pin",
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const release = { ...f.options.release, modules: { entry: { bytes: 1, sha256: "entry" } } };
        const facet = yield* createHarnessSessionFacet({ ...f.options, release });
        release.modules.entry.sha256 = "changed after construction";
        const session = yield* facet.open(f.adapter.input);
        expect(f.built[0]?.computer.files).toBe(f.bindings.files);
        expect(f.built[0]?.computer.files.descriptors).toBe(f.bindings.files.descriptors);
        expect(f.built[0]?.modelTransport).toBe(f.options.modelTransport);
        expect(f.built[0]?.hooks).toBe(f.options.hooks);
        expect(session.release.modules.entry?.sha256).toBe("entry");
        const terminal = yield* Deferred.make<void>();
        const collector = yield* session.events.pipe(
          Stream.runForEach((item) =>
            item.kind === "provider" && item.event.type === "turn.terminal"
              ? Deferred.succeed(terminal, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* session.turn(f.adapter.turn);
        yield* f.adapter.nextStart;
        yield* f.adapter.named();
        yield* session.control({
          type: "interrupt",
          runId: f.adapter.turn.runId,
          preparationGeneration: 1,
        });
        yield* f.adapter.nextInterrupt;
        yield* f.adapter.terminal();
        yield* Deferred.await(terminal);
        const checkpoint = yield* session.export();
        expect(checkpoint.revision.commit).toBe("computer-revision");
        yield* session.dispose;
        yield* Fiber.join(collector);
        expect(f.sessionSignals[0]?.aborted).toBe(true);
        expect(f.ownerSignals[0]?.aborted).toBe(false);
        const changed = { ...checkpoint, release: { ...checkpoint.release, version: "other" } };
        expect(
          Result.isFailure(
            yield* facet
              .open({ session: f.adapter.input.session, checkpoint: changed })
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(f.built).toHaveLength(1);
        const resumed = yield* facet.open({ session: f.adapter.input.session, checkpoint });
        expect(f.built[1]?.computer).toBe(f.built[0]?.computer);
        expect(f.built[1]?.release).toBe(session.release);
        expect(f.built[1]?.session.initialNativeThreadId).toBe("native-thread");
        expect(f.adapter.calls.filter((call) => call === "resume")).toHaveLength(1);
        expect((yield* resumed.export()).snapshot).toEqual(checkpoint.snapshot);
        yield* facet.dispose;
        expect(f.ownerSignals[0]?.aborted).toBe(true);
        expect(f.cleaned).toHaveLength(2);
        expect(Result.isFailure(yield* facet.open(f.adapter.input).pipe(Effect.result))).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("cancels only the open waiter while a shared Computer bind remains alive", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const began = Promise.withResolvers<AbortSignal>();
      const ready = Promise.withResolvers<void>();
      let binds = 0;
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        computer: {
          bind: async (_thread, signal) => {
            binds++;
            began.resolve(signal);
            await ready.promise;
            return f.bindings;
          },
        },
      });
      const opening = yield* facet.open(f.adapter.input).pipe(Effect.forkScoped);
      const signal = yield* Effect.promise(() => began.promise);
      yield* Fiber.interrupt(opening);
      expect(signal.aborted).toBe(false);
      ready.resolve();
      const session = yield* facet.open(f.adapter.input);
      expect(binds).toBe(1);
      expect(f.built).toHaveLength(1);
      yield* session.dispose;
    }).pipe(Effect.scoped),
  );

  it.effect("aborts binding and pending opens when the facet is disposed", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const began = Promise.withResolvers<AbortSignal>();
      const ready = Promise.withResolvers<void>();
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        computer: {
          bind: async (_thread, signal) => {
            began.resolve(signal);
            await ready.promise;
            return f.bindings;
          },
        },
      });
      const opening = yield* facet.open(f.adapter.input).pipe(Effect.exit, Effect.forkScoped);
      const signal = yield* Effect.promise(() => began.promise);
      yield* facet.dispose;
      expect(signal.aborted).toBe(true);
      expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
      expect(f.built).toHaveLength(0);
      ready.resolve();
    }).pipe(Effect.scoped),
  );

  it.effect("cleans a cancelled native builder and can open again without rebinding", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const building = yield* Deferred.make<AbortSignal>();
      let attempts = 0;
      let cleaned = false;
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: (input, signal) =>
          Effect.gen(function* () {
            if (++attempts > 1) return yield* f.options.buildRuntime!(input, signal);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                expect(signal.aborted).toBe(true);
                cleaned = true;
              }),
            );
            yield* Deferred.succeed(building, signal);
            return yield* Effect.never;
          }),
      });
      const opening = yield* facet.open(f.adapter.input).pipe(Effect.forkScoped);
      const signal = yield* Deferred.await(building);
      yield* Fiber.interrupt(opening);
      expect(signal.aborted).toBe(true);
      expect(cleaned).toBe(true);
      yield* facet.open(f.adapter.input);
      expect(f.ownerSignals).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects another thread and a second live session before building another runtime",
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const facet = yield* createHarnessSessionFacet(f.options);
        const wrong = { session: { ...f.adapter.input.session, threadId: ThreadId.make("other") } };
        expect(Result.isFailure(yield* facet.open(wrong).pipe(Effect.result))).toBe(true);
        expect(f.ownerSignals).toHaveLength(0);
        yield* facet.open(f.adapter.input);
        expect(Result.isFailure(yield* facet.open(f.adapter.input).pipe(Effect.result))).toBe(true);
        expect(f.built).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("reports missing capabilities explicitly and cleans failed runtime construction", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const { computer: _computer, buildRuntime: _builder, ...missing } = f.options;
      const noComputer = yield* createHarnessSessionFacet(missing).pipe(Effect.flip);
      expect(noComputer.message).toContain("Computer binding is unavailable");
      const noBuilder = yield* createHarnessSessionFacet({
        ...missing,
        computer: { bind: async () => f.bindings },
      }).pipe(Effect.flip);
      expect(noBuilder.message).toContain("native runtime builder is unavailable");
      let cleaned = false;
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                cleaned = true;
              }),
            );
            return yield* Effect.fail(
              new HarnessError({
                operation: "open",
                message: "native module rejected",
              }),
            );
          }),
      });
      expect((yield* facet.open(f.adapter.input).pipe(Effect.flip)).message).toBe(
        "native module rejected",
      );
      expect(cleaned).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "joins process cleanup before allowing reopen and closes resources with the owning Scope",
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const scope = yield* Scope.make();
        const cleaning = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let cleaned = false;
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: (input, signal) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.sync(() => {
                      expect(signal.aborted).toBe(true);
                      cleaned = true;
                    }),
                  ),
                ),
              );
              return yield* f.options.buildRuntime!(input, signal);
            }),
        }).pipe(Scope.provide(scope));
        const session = yield* facet.open(f.adapter.input);
        const first = yield* session.dispose.pipe(Effect.forkScoped);
        yield* Deferred.await(cleaning);
        const second = yield* session.dispose.pipe(Effect.forkScoped);
        expect(Result.isFailure(yield* facet.open(f.adapter.input).pipe(Effect.result))).toBe(true);
        expect(cleaned).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(cleaned).toBe(true);
        yield* facet.open(f.adapter.input);
        yield* Scope.close(scope, Exit.void);
        expect(f.ownerSignals[0]?.aborted).toBe(true);
        expect(f.sessionSignals.every((signal) => signal.aborted)).toBe(true);
        expect(f.cleaned).toHaveLength(2);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "passes the real owner signal to an injected opener and rejects a replacement Computer",
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        let owner: AbortSignal | undefined;
        let computer: Computer = { threadId: f.options.threadId, ...f.bindings };
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          computer: {
            open: (signal) => {
              owner = signal;
              return { open: async () => computer };
            },
          },
        });
        const session = yield* facet.open(f.adapter.input);
        expect(f.built[0]?.computer).toBe(computer);
        yield* session.dispose;
        expect(owner?.aborted).toBe(false);
        computer = { ...computer };
        const error = yield* facet.open(f.adapter.input).pipe(Effect.flip);
        expect(error.message).toContain("Computer identity changed");
        expect(f.built).toHaveLength(1);
        yield* facet.dispose;
        expect(owner?.aborted).toBe(true);
      }).pipe(Effect.scoped),
  );
  it.effect("aborts native acquisition before joining caller cancellation", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const native = nativeAcquisition(f.buildRuntime);
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: native.buildRuntime,
      });
      const opening = yield* facet.open(f.adapter.input).pipe(Effect.forkScoped);
      const signal = yield* native.acquiring;
      const cancelling = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(0);
        expect(signal.aborted).toBe(true);
        expect(f.ownerSignals[0]?.aborted).toBe(false);
      }).pipe(Effect.ensuring(native.complete));
      yield* Fiber.join(cancelling);
      const exit = yield* Fiber.await(opening);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(native.released).toBe(1);
      const session = yield* facet.open(f.adapter.input);
      expect(f.ownerSignals).toHaveLength(1);
      yield* session.dispose;
    }).pipe(Effect.scoped),
  );

  it.effect("protects caller cancellation at the worker fork boundary", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const facet = yield* createHarnessSessionFacet(f.options);
      const boundary = forkBoundaryScheduler();
      const opening = yield* Effect.withFiber((fiber) => {
        boundary.arm(fiber);
        return facet.open(f.adapter.input);
      }).pipe(Effect.provideService(Scheduler.Scheduler, boundary.scheduler), Effect.forkScoped);
      const exit = yield* Fiber.await(opening);
      expect(boundary.interrupted).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      const session = yield* facet.open(f.adapter.input);
      yield* session.dispose;
      expect(f.cleaned).toHaveLength(f.built.length);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses reopen after native release fails and retains that failure", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const failure = new Error("native resource retained");
      const native = nativeAcquisition(f.buildRuntime, Effect.die(failure));
      yield* native.complete;
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: native.buildRuntime,
      });
      const session = yield* facet.open(f.adapter.input);
      const disposed = yield* session.dispose.pipe(Effect.flip);
      expect(disposed.cause).toBeDefined();
      const reopened = yield* facet.open(f.adapter.input).pipe(Effect.result);
      expect(Result.isFailure(reopened)).toBe(true);
      if (Result.isFailure(reopened)) expect(reopened.failure.cause).toBeDefined();
      expect(f.built).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["dispose", "parent Scope"] as const)(
    "returns HarnessError when %s interrupts a native builder",
    (shutdown) =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const parent = yield* Scope.make();
        const building = yield* Deferred.make<void>();
        const native = nativeAcquisition((input, signal) =>
          f
            .buildRuntime(input, signal)
            .pipe(
              Effect.andThen(Deferred.succeed(building, undefined)),
              Effect.andThen(Effect.never),
            ),
        );
        yield* native.complete;
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: native.buildRuntime,
        }).pipe(Scope.provide(parent));
        const opening = yield* facet.open(f.adapter.input).pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(building);
        yield* shutdown === "dispose" ? facet.dispose : Scope.close(parent, Exit.void);
        const exit = yield* Fiber.join(opening);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0];
          expect(reason?._tag).toBe("Fail");
          if (reason !== undefined && Cause.isFailReason(reason)) {
            expect(reason.error).toBeInstanceOf(HarnessError);
            expect(reason.error.message).toContain("disposed");
          }
        }
        expect(native.released).toBe(1);
        yield* Scope.close(parent, Exit.void);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps caller interruption and native cleanup defects, then refuses reopen", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const parent = yield* Scope.make();
      const failure = new Error("cancelled native resource retained");
      const native = nativeAcquisition(f.buildRuntime, Effect.die(failure));
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: native.buildRuntime,
      }).pipe(Scope.provide(parent));
      const opening = yield* facet.open(f.adapter.input).pipe(Effect.forkScoped);
      yield* native.acquiring;
      const cancelling = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
      yield* TestClock.adjust(0).pipe(Effect.ensuring(native.complete));
      yield* Fiber.join(cancelling);
      const exit = yield* Fiber.await(opening);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(f.ownerSignals[0]?.aborted).toBe(false);
      const error = yield* facet.open(f.adapter.input).pipe(Effect.flip);
      expect(error.message).toContain("cleanup failed");
      expect(error.cause).toMatchObject({
        reasons: expect.arrayContaining([
          expect.objectContaining({ _tag: "Die", defect: failure }),
        ]),
      });
      expect(f.built).toHaveLength(0);
      const closed = yield* Scope.close(parent, Exit.void).pipe(Effect.exit);
      expect(Exit.isFailure(closed) && Cause.hasDies(closed.cause)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves cleanup defects when owner disposal interrupts a native builder", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const building = yield* Deferred.make<void>();
      const failure = new Error("owner cleanup failed");
      const native = nativeAcquisition(
        (input, signal) =>
          f
            .buildRuntime(input, signal)
            .pipe(
              Effect.andThen(Deferred.succeed(building, undefined)),
              Effect.andThen(Effect.never),
            ),
        Effect.die(failure),
      );
      yield* native.complete;
      const facet = yield* createHarnessSessionFacet({
        ...f.options,
        buildRuntime: native.buildRuntime,
      });
      const opening = yield* facet.open(f.adapter.input).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(building);
      yield* facet.dispose.pipe(Effect.exit);
      const exit = yield* Fiber.join(opening);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect: failure }),
        );
    }).pipe(Effect.scoped),
  );
  it.effect.each([false, true])(
    "cleans a successful session at mask exit, release failure %s",
    (fails) =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const boundary = handoffBoundaryScheduler();
        const parent = yield* Scope.make();
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: (input, signal) =>
            Effect.withFiber((fiber) => {
              boundary.worker(fiber);
              return Effect.acquireRelease(Effect.void, () =>
                fails ? Effect.die(new Error("handoff release failed")) : Effect.void,
              ).pipe(Effect.andThen(f.buildRuntime(input, signal)));
            }),
        }).pipe(Scope.provide(parent));
        const opening = yield* Effect.withFiber((fiber) => {
          boundary.arm(fiber);
          return facet.open(f.adapter.input);
        }).pipe(Effect.provideService(Scheduler.Scheduler, boundary.scheduler), Effect.forkScoped);
        const exit = yield* Fiber.await(opening);
        expect(boundary.interrupted).toBe(true);
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(f.cleaned).toHaveLength(1);
        expect(f.ownerSignals[0]?.aborted).toBe(false);
        if (fails) {
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          expect((yield* facet.open(f.adapter.input).pipe(Effect.flip)).message).toContain(
            "cleanup failed",
          );
        } else {
          const session = yield* facet.open(f.adapter.input);
          yield* session.dispose;
        }
        const closed = yield* Scope.close(parent, Exit.void).pipe(Effect.exit);
        expect(Exit.isFailure(closed)).toBe(fails);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["dispose", "parent Scope"] as const)(
    "reports late acquisition cleanup failure from %s",
    (shutdown) =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const parent = yield* Scope.make();
        const failure = new Error("late native release failed");
        const native = nativeAcquisition(f.buildRuntime, Effect.die(failure));
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: native.buildRuntime,
        }).pipe(Scope.provide(parent));
        const opening = yield* facet.open(f.adapter.input).pipe(Effect.exit, Effect.forkScoped);
        yield* native.acquiring;
        const closed = yield* (
          shutdown === "dispose" ? facet.dispose : Scope.close(parent, Exit.void)
        ).pipe(Effect.exit);
        const opened = yield* Fiber.join(opening);
        expect(Exit.isFailure(opened) && Cause.hasDies(opened.cause)).toBe(true);
        expect(native.released).toBe(1);
        expect(Exit.isFailure(closed)).toBe(true);
        if (Exit.isFailure(closed)) {
          if (shutdown === "dispose") {
            const reason = closed.cause.reasons[0];
            expect(reason?._tag).toBe("Fail");
            if (reason !== undefined && Cause.isFailReason(reason))
              expect(reason.error).toMatchObject({
                operation: "dispose",
                cause: {
                  reasons: expect.arrayContaining([
                    expect.objectContaining({ _tag: "Die", defect: failure }),
                  ]),
                },
              });
          } else
            expect(closed.cause.reasons).toContainEqual(
              expect.objectContaining({ _tag: "Die", defect: failure }),
            );
        }
        expect(Result.isFailure(yield* facet.open(f.adapter.input).pipe(Effect.result))).toBe(true);
        expect(f.built).toHaveLength(0);
        yield* Scope.close(parent, Exit.void).pipe(Effect.exit);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["dispose", "parent Scope"] as const)(
    "joins an unpublished native worker during %s",
    (shutdown) =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const parent = yield* Scope.make();
        const boundary = ownerForkBoundaryScheduler();
        const failure = new Error("unpublished native worker cleanup failed");
        const native = nativeAcquisition(f.buildRuntime, Effect.die(failure));
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: native.buildRuntime,
        }).pipe(Scope.provide(parent));
        const opening = yield* Effect.withFiber((fiber) => {
          boundary.arm(fiber);
          return facet.open(f.adapter.input);
        }).pipe(
          Effect.provideService(Scheduler.Scheduler, boundary.scheduler),
          Effect.exit,
          Effect.forkScoped,
        );
        const signal = yield* native.acquiring;
        const closing = yield* (
          shutdown === "dispose" ? facet.dispose : Scope.close(parent, Exit.void)
        ).pipe(Effect.exit, Effect.forkScoped);
        yield* TestClock.adjust(0).pipe(
          Effect.andThen(Effect.sync(() => expect(signal.aborted).toBe(true))),
          Effect.ensuring(boundary.resume),
        );
        const closed = yield* Fiber.join(closing);
        const opened = yield* Fiber.join(opening);
        expect(native.released).toBe(1);
        expect(Exit.isFailure(closed)).toBe(true);
        expect(Exit.isFailure(opened) && Cause.hasDies(opened.cause)).toBe(true);
        yield* Scope.close(parent, Exit.void).pipe(Effect.exit);
      }).pipe(Effect.scoped),
  );
  it.effect.each([false, true])(
    "accounts for the ordinary interruption observer's success callback, release failure %s",
    (fails) =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const parent = yield* Scope.make();
        const boundary = observerBoundaryScheduler(false);
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: (input, signal) =>
            Effect.withFiber((fiber) => {
              boundary.worker(fiber);
              return Effect.acquireRelease(Effect.void, () =>
                fails ? Effect.die(new Error("observer release failed")) : Effect.void,
              ).pipe(Effect.andThen(f.buildRuntime(input, signal)));
            }),
        }).pipe(Scope.provide(parent));
        const opening = yield* Effect.withFiber((fiber) => {
          boundary.arm(fiber);
          return facet.open(f.adapter.input).pipe(Effect.tap(() => boundary.delivered));
        }).pipe(Effect.provideService(Scheduler.Scheduler, boundary.scheduler), Effect.forkScoped);
        const exit = yield* Fiber.await(opening);
        expect(boundary.captured).toBe(true);
        if (Exit.isSuccess(exit)) yield* exit.value.dispose.pipe(Effect.exit);
        else {
          expect(boundary.interrupted).toBe(true);
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          if (fails) expect(Cause.hasDies(exit.cause)).toBe(true);
        }
        expect(f.cleaned).toHaveLength(1);
        expect(f.ownerSignals[0]?.aborted).toBe(false);
        if (fails)
          expect((yield* facet.open(f.adapter.input).pipe(Effect.flip)).message).toContain(
            "cleanup failed",
          );
        else yield* (yield* facet.open(f.adapter.input)).dispose;
        yield* Scope.close(parent, Exit.void).pipe(Effect.exit);
      }).pipe(Effect.scoped),
  );

  it.effect("cancels before the masked body without awaiting an unpublished worker", () =>
    Effect.gen(function* () {
      const f = yield* sessionFacetFixture;
      const reached = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const boundary = observerBoundaryScheduler(true, () => {
        Deferred.doneUnsafe(reached, Effect.void);
      });
      const facet = yield* createHarnessSessionFacet(f.options);
      // The red candidate cannot be interrupted out of its own deadlocked finalizer.
      const opening = yield* Effect.withFiber((fiber) => {
        boundary.arm(fiber);
        return facet.open(f.adapter.input);
      }).pipe(Effect.provideService(Scheduler.Scheduler, boundary.scheduler), Effect.forkDetach);
      yield* Effect.sync(() =>
        opening.addObserver(() => {
          Deferred.doneUnsafe(completed, Effect.void);
        }),
      );
      yield* Deferred.await(reached);
      yield* TestClock.adjust(0);
      expect(boundary.captured).toBe(true);
      expect(boundary.interrupted).toBe(true);
      expect(yield* Deferred.isDone(completed)).toBe(true);
      const exit = yield* Fiber.await(opening);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(f.built).toHaveLength(0);
      expect(f.ownerSignals).toHaveLength(0);
      yield* (yield* facet.open(f.adapter.input)).dispose;
    }).pipe(Effect.scoped),
  );
  it.effect.each([false, true])(
    "closes native lifetime after interrupted worker success handoff, release failure %s",
    (fails) =>
      Effect.gen(function* () {
        const f = yield* sessionFacetFixture;
        const parent = yield* Scope.make();
        const boundary = workerHandoffBoundaryScheduler();
        const failure = new Error("worker handoff native release failed");
        let releases = 0;
        const facet = yield* createHarnessSessionFacet({
          ...f.options,
          buildRuntime: (input, signal) =>
            Effect.withFiber((fiber) => {
              boundary.worker(fiber);
              return Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  expect(signal.aborted).toBe(true);
                  releases++;
                }).pipe(Effect.andThen(fails ? Effect.die(failure) : Effect.void)),
              ).pipe(Effect.andThen(f.buildRuntime(input, signal)));
            }),
        }).pipe(Scope.provide(parent));
        yield* Effect.gen(function* () {
          const opening = yield* Effect.withFiber((fiber) => {
            boundary.arm(fiber);
            return facet.open(f.adapter.input);
          }).pipe(
            Effect.provideService(Scheduler.Scheduler, boundary.scheduler),
            Effect.forkScoped,
          );
          const exit = yield* Fiber.await(opening);
          expect(boundary.interrupted).toBe(true);
          const workerExit = boundary.workerExit;
          expect(
            workerExit !== undefined &&
              Exit.isFailure(workerExit) &&
              Cause.hasInterruptsOnly(workerExit.cause),
          ).toBe(true);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(fails);
          expect(releases).toBe(1);
          expect(f.cleaned).toHaveLength(1);
          expect(f.sessionSignals[0]?.aborted).toBe(true);
          expect(f.ownerSignals[0]?.aborted).toBe(false);
          if (fails) {
            expect(Exit.isFailure(exit) && exit.cause.reasons).toContainEqual(
              expect.objectContaining({ _tag: "Die", defect: failure }),
            );
            expect((yield* facet.open(f.adapter.input).pipe(Effect.flip)).message).toContain(
              "cleanup failed",
            );
          } else yield* (yield* facet.open(f.adapter.input)).dispose;
          const closed = yield* facet.dispose.pipe(Effect.exit);
          expect(Exit.isFailure(closed)).toBe(fails);
          const again = yield* facet.dispose.pipe(Effect.exit);
          expect(again).toEqual(closed);
          expect(releases).toBe(fails ? 1 : 2);
        }).pipe(Effect.ensuring(Scope.close(parent, Exit.void).pipe(Effect.exit)));
      }).pipe(Effect.scoped),
  );
});
