import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { hostFixture } from "./hostFixture.ts";

describe("HarnessSessionHost", () => {
  it.effect("drains caller-interrupted acquisition before another boot attempt can bind", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const acquiring = yield* Deferred.make<void>();
      const acquired = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      let bindings = 0;
      let releases = 0;
      let callerEnded = false;
      let fileIsLive = () => false;
      let canonicalFilesAreLive = () => false;
      const instance = yield* f.make({
        bindComputer: ({ files, signal }) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              bindings++;
              const fd = files.open("/bin/bash", KernelOpenFlags.O_RDONLY);
              fileIsLive = () => {
                files.fstat(fd);
                return true;
              };
              canonicalFilesAreLive = () => {
                files.stat("/bin/bash");
                return true;
              };
              signal.addEventListener("abort", () => Deferred.doneUnsafe(cancelled, Effect.void), {
                once: true,
              });
              yield* Deferred.succeed(acquiring, undefined);
              yield* Deferred.await(acquired);
              return fd;
            }),
            (fd) =>
              Effect.gen(function* () {
                expect(signal.aborted).toBe(true);
                files.fstat(fd);
                yield* Deferred.succeed(cleaning, undefined);
                yield* Deferred.await(cleaned);
                files.fstat(fd);
                files.close(fd);
                releases++;
              }),
          ).pipe(
            Effect.as({
              exec: async () => {
                throw new Error("Unexpected exec during acquisition");
              },
              port: async () => {
                throw new Error("Unexpected port during acquisition");
              },
              save: async () => ({ commit: "unused-acquisition" }),
            }),
          ),
      });
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const opening = yield* instance.open("attempt-A").pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            callerEnded = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(acquiring);
      const interrupting = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(acquired, undefined).pipe(
          Effect.andThen(Deferred.succeed(cleaned, undefined)),
        ),
      );
      const first = yield* Effect.raceFirst(
        Deferred.await(cancelled).pipe(Effect.as("cancel-requested")),
        Fiber.await(opening).pipe(Effect.as("caller-ended")),
      );
      expect(first).toBe("cancel-requested");
      expect(callerEnded).toBe(false);
      expect(fileIsLive()).toBe(true);
      const next = yield* instance.open("attempt-B").pipe(Effect.exit, Effect.forkScoped);
      expect(bindings).toBe(1);
      expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
      yield* Deferred.succeed(acquired, undefined);
      yield* Deferred.await(cleaning);
      expect(callerEnded).toBe(false);
      expect(fileIsLive()).toBe(true);
      expect(bindings).toBe(1);
      expect(releases).toBe(0);
      expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
      yield* Deferred.succeed(cleaned, undefined);
      yield* Fiber.join(interrupting);
      expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true);
      expect(Exit.isFailure(yield* Fiber.join(next))).toBe(true);
      expect(callerEnded).toBe(true);
      expect(bindings).toBe(1);
      expect(releases).toBe(1);
      expect(f.acquisitions).toHaveLength(0);
      expect(canonicalFilesAreLive()).toBe(true);
      expect(Exit.isFailure(yield* instance.open("attempt-C").pipe(Effect.exit))).toBe(true);
      expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
      yield* instance.host.dispose;
      expect(releases).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect.each([false, true])(
    "joins pending acquisition before file disposal (cleanup failure=%s)",
    (cleanupFailure) =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const acquiring = yield* Deferred.make<void>();
        const acquired = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        const cancelled = Promise.withResolvers<void>();
        let disposed = false;
        let filesValidDuringCleanup = false;
        let fileIsLive = () => false;
        const instance = yield* f.make({
          bindComputer: ({ files, signal }) =>
            Effect.acquireRelease(
              Effect.gen(function* () {
                const fd = files.open("/bin/bash", KernelOpenFlags.O_RDONLY);
                fileIsLive = () => {
                  files.fstat(fd);
                  return true;
                };
                signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
                yield* Deferred.succeed(acquiring, undefined);
                yield* Deferred.await(acquired);
                return fd;
              }),
              (fd) =>
                Effect.gen(function* () {
                  filesValidDuringCleanup =
                    (yield* Effect.try(() => files.fstat(fd)).pipe(Effect.exit))._tag === "Success";
                  yield* Deferred.succeed(cleaning, undefined);
                  yield* Deferred.await(cleaned);
                  if (filesValidDuringCleanup) {
                    files.fstat(fd);
                    files.close(fd);
                  }
                  if (cleanupFailure) throw new Error("opaque-acquisition-secret");
                }),
            ).pipe(
              Effect.as({
                exec: async () => {
                  throw new Error("Unexpected exec during acquisition");
                },
                port: async () => {
                  throw new Error("Unexpected port during acquisition");
                },
                save: async () => ({ commit: "unused-acquisition" }),
              }),
            ),
        });
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const opening = yield* instance.open().pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(acquiring);
        const disposing = yield* instance.host.dispose.pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              disposed = true;
            }),
          ),
          Effect.exit,
          Effect.forkScoped,
        );
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(acquired, undefined).pipe(
            Effect.andThen(Deferred.succeed(cleaned, undefined)),
          ),
        );
        yield* Effect.promise(() => cancelled.promise);
        expect(disposed).toBe(false);
        expect(fileIsLive()).toBe(true);
        yield* Deferred.succeed(acquired, undefined);
        yield* Deferred.await(cleaning);
        expect(disposed).toBe(false);
        expect(filesValidDuringCleanup).toBe(true);
        expect(fileIsLive()).toBe(true);
        yield* Deferred.succeed(cleaned, undefined);
        const disposal = yield* Fiber.join(disposing);
        expect(Exit.isFailure(disposal)).toBe(cleanupFailure);
        if (Exit.isFailure(disposal)) {
          expect(Cause.pretty(disposal.cause)).toContain("Harness host cleanup failed.");
          expect(Cause.pretty(disposal.cause)).not.toContain("opaque-acquisition-secret");
        }
        expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
        expect(disposed).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reopens cleanly on one Computer, preserves controls/export and consumes attempts",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        const session = yield* instance.open();
        const terminal = yield* session.events.pipe(
          Stream.filter((item) => item.kind === "provider" && item.event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* session.turn({ turn: instance.adapter.turn, access: f.access("grant-A") });
        yield* instance.adapter.nextStart;
        yield* instance.adapter.named();
        yield* session.control({
          type: "interrupt",
          runId: instance.adapter.turn.runId,
          preparationGeneration: 1,
        });
        yield* instance.adapter.nextInterrupt;
        yield* instance.adapter.terminal();
        yield* Fiber.join(terminal);
        const checkpoint = yield* session.export();
        expect(checkpoint.revision.commit).toBe("computer-revision");
        yield* session.dispose;
        expect(Exit.isFailure(yield* instance.open().pipe(Effect.exit))).toBe(true);
        const reopened = yield* instance.host.open({
          session: instance.adapter.input.session,
          checkpoint,
          bootAttemptId: "boot-2",
        });
        expect(f.acquisitions).toHaveLength(2);
        expect(f.acquisitions[0]?.computer).toBe(f.acquisitions[1]?.computer);
        expect(f.computers).toHaveLength(1);
        yield* reopened.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "consumes a failed native attempt, then accepts a new attempt after clean cleanup",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        f.failAcquisition(true);
        expect(Exit.isFailure(yield* instance.open().pipe(Effect.exit))).toBe(true);
        f.failAcquisition(false);
        expect(Exit.isFailure(yield* instance.open().pipe(Effect.exit))).toBe(true);
        const recovered = yield* instance.open("fresh-attempt");
        expect(f.acquisitions).toHaveLength(2);
        yield* recovered.dispose;
      }).pipe(Effect.scoped),
  );

  it.effect("poisons reopen after native cleanup fails and sanitizes the injected failure", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      const session = yield* instance.open();
      f.setCleanup(Effect.die("opaque-grant-secret"));
      const exit = yield* session.dispose.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).not.toContain("opaque-grant-secret");
      expect(Exit.isFailure(yield* instance.open("fresh-attempt").pipe(Effect.exit))).toBe(true);
      yield* instance.host.dispose.pipe(Effect.ignore);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "validates thread/checkpoint identity before a claim and rejects occupied ownership",
    () =>
      Effect.gen(function* () {
        const f = yield* hostFixture;
        const instance = yield* f.make();
        yield* instance.host.seed("assets");
        yield* instance.host.seed("programs");
        expect(
          Exit.isFailure(
            yield* instance.host
              .open({
                session: { ...instance.adapter.input.session, threadId: ThreadId.make("wrong") },
                bootAttemptId: "bad",
              })
              .pipe(Effect.exit),
          ),
        ).toBe(true);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(0);
        const session = yield* instance.open();
        expect(Exit.isFailure(yield* instance.open("other").pipe(Effect.exit))).toBe(true);
        expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
        yield* session.dispose;
      }).pipe(Effect.scoped),
  );
  it.effect("requires the native configuration port even before the first turn", () =>
    Effect.gen(function* () {
      const f = yield* hostFixture;
      f.omitConfigurationPort();
      const instance = yield* f.make();
      yield* instance.host.seed("assets");
      yield* instance.host.seed("programs");
      expect(Exit.isFailure(yield* instance.open().pipe(Effect.exit))).toBe(true);
      expect(f.acquisitions).toHaveLength(0);
      expect(f.handle.rows("SELECT * FROM harness_boot_attempts")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
