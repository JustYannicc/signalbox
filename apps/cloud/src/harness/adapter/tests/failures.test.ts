import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId, ProviderThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";

import { fixture } from "./fixture.ts";

const stable = Effect.gen(function* () {
  const f = yield* fixture;
  const opened = yield* f.open();
  yield* opened.session.turn(f.turn);
  yield* opened.next;
  yield* opened.next;
  yield* f.terminal();
  yield* opened.next;
  yield* opened.next;
  const checkpoint = yield* opened.session.export();
  return { ...f, ...opened, checkpoint };
});

describe("AdapterHarness failures", () => {
  it.effect(
    "publishes a saved terminal even when the provider cannot export a native snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setSnapshotFailure();
        const { session, next } = yield* f.open();
        yield* session.turn(f.turn);
        yield* next;
        yield* next;
        yield* f.terminal();
        yield* next;
        const terminal = yield* next;
        expect(terminal.kind === "provider" && terminal.event.type).toBe("turn.terminal");
        expect(f.calls).toContain("save");
        expect(f.calls).not.toContain("snapshot");
        expect(Result.isFailure(yield* session.export().pipe(Effect.result))).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects checkpoint session, native-thread and running-state mismatches before launching",
    () =>
      Effect.gen(function* () {
        const f = yield* stable;
        const invalid = [
          {
            ...f.checkpoint,
            providerSession: {
              ...f.checkpoint.providerSession,
              id: ProviderSessionId.make("other"),
            },
          },
          {
            ...f.checkpoint,
            snapshot: {
              ...f.checkpoint.snapshot,
              providerThread: { ...f.checkpoint.snapshot.providerThread, nativeThreadRef: null },
            },
          },
          { ...f.checkpoint, snapshot: { ...f.checkpoint.snapshot, providerTurns: [f.native()] } },
        ];
        for (const checkpoint of invalid) {
          expect(
            Result.isFailure(yield* f.service.open({ ...f.input, checkpoint }).pipe(Effect.result)),
          ).toBe(true);
        }
        expect(
          Result.isFailure(
            yield* f.service
              .open({
                ...f.input,
                checkpoint: f.checkpoint,
                session: { ...f.input.session, initialNativeThreadId: "other" },
              })
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(f.opened).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "fails native checkpoint resume, closes the new runtime, and never creates a fresh thread",
    () =>
      Effect.gen(function* () {
        const f = yield* stable;
        f.setResumeFailure();
        const result = yield* f.service
          .open({ ...f.input, checkpoint: f.checkpoint })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.operation).toBe("open");
        expect(f.calls.slice(-3)).toEqual(["resume", "cleanup:start", "cleanup:end"]);
        expect(f.calls.filter((call) => call === "ensure")).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "exports only idle snapshots and rejects background work and cross-thread snapshots",
    () =>
      Effect.gen(function* () {
        const f = yield* stable;
        f.setPendingBackground(true);
        expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
        f.setPendingBackground(false);
        f.setSnapshot({ ...f.checkpoint.snapshot, providerTurns: [f.native()] });
        expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
        f.setSnapshot({
          ...f.checkpoint.snapshot,
          providerThread: {
            ...f.checkpoint.snapshot.providerThread,
            id: ProviderThreadId.make("other"),
          },
        });
        expect(Result.isFailure(yield* f.session.export().pipe(Effect.result))).toBe(true);
        f.setSnapshot(f.checkpoint.snapshot);
        expect((yield* f.session.export()).snapshot).toEqual(f.checkpoint.snapshot);
        f.setSaveFailure(new Error("save failed"));
        const saved = yield* f.session.export().pipe(Effect.result);
        expect(Result.isFailure(saved)).toBe(true);
        if (Result.isFailure(saved)) expect(saved.failure.operation).toBe("export");
      }).pipe(Effect.scoped),
  );

  it.effect("releases pending start callers when the runtime stream fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setStartGate(Effect.never);
      const { session, collector } = yield* f.open();
      const starting = yield* session.turn(f.turn).pipe(Effect.result, Effect.forkScoped);
      yield* f.nextStart;
      yield* f.endEvents;
      expect(Result.isFailure(yield* Fiber.join(starting))).toBe(true);
      expect(Exit.isFailure(yield* Fiber.join(collector))).toBe(true);
      yield* session.dispose;
      expect(f.calls).toContain("cleanup:end");
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts an in-flight runtime start and awaits cleanup during disposal", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const interrupted = yield* Deferred.make<void>();
      f.setStartGate(
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      );
      const { session } = yield* f.open();
      const starting = yield* session.turn(f.turn).pipe(Effect.result, Effect.forkScoped);
      yield* f.nextStart;
      yield* session.dispose;
      yield* Deferred.await(interrupted);
      expect(Result.isFailure(yield* Fiber.join(starting))).toBe(true);
      expect(f.calls).toContain("cleanup:end");
      expect(
        Result.isFailure(
          yield* session
            .control({ type: "interrupt", runId: f.turn.runId, preparationGeneration: 1 })
            .pipe(Effect.result),
        ),
      ).toBe(true);
      expect(Result.isFailure(yield* session.export().pipe(Effect.result))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports cleanup failure without replacing the runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setCleanup(Effect.die(new Error("cleanup failed")));
      const { session } = yield* f.open();
      const disposed = yield* session.dispose.pipe(Effect.result);
      expect(Result.isFailure(disposed)).toBe(true);
      if (Result.isFailure(disposed)) expect(disposed.failure.operation).toBe("dispose");
      expect(Result.isFailure(yield* session.dispose.pipe(Effect.result))).toBe(true);
      expect(f.calls.filter((call) => call === "cleanup:start")).toHaveLength(1);
      expect(f.opened).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
