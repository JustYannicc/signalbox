import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { type HarnessRequestCheckpoint } from "../../HarnessRunStore.ts";
import { publisher, requestFacetFixture, runId, controlKey } from "./fixture.ts";

describe("request-scoped Harness facet", () => {
  it.effect(
    "reuses the native heap across requests while committing each checkpoint separately",
    () =>
      Effect.gen(function* () {
        const f = yield* requestFacetFixture;
        let opened = 0;
        let turns = 0;
        let disposed = false;
        const signals: AbortSignal[] = [];
        const facet = yield* f.create((restored) =>
          Effect.gen(function* () {
            opened += 1;
            expect(restored).toEqual(f.initial);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                disposed = true;
              }),
            );
            return {
              run: (_input, context) =>
                Effect.gen(function* () {
                  yield* context.check;
                  signals.push(context.signal);
                  turns += 1;
                  yield* context.progress("native-event", f.reference(`event-${turns}`));
                  return {
                    status: "completed" as const,
                    result: f.reference(`result-${turns}`),
                    checkpoint: f.checkpoint(`turn-${turns}`),
                  };
                }),
            };
          }),
        );
        yield* f.offer("one");
        const first = yield* facet.run({ publisher: publisher(), requestId: "one" });
        expect(first.action).toBe("committed");
        expect(first.snapshot.requests?.entries[0]?.finish?.sequence).toBe(2);
        expect(signals[0]?.aborted).toBe(true);
        expect(disposed).toBe(false);
        yield* f.offer("two");
        const second = yield* facet.run({ publisher: publisher(), requestId: "two" });
        expect(second.snapshot.requests?.checkpoint).toEqual(f.checkpoint("turn-2"));
        expect({ opened, turns }).toEqual({ opened: 1, turns: 2 });
        yield* facet.dispose;
        expect(disposed).toBe(true);
      }),
  );

  it.effect(
    "a duplicate observes an in-flight request and later returns its committed result",
    () =>
      Effect.gen(function* () {
        const f = yield* requestFacetFixture;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let turns = 0;
        const facet = yield* f.create(() =>
          Effect.succeed({
            run: () =>
              Effect.gen(function* () {
                turns += 1;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  status: "completed" as const,
                  result: f.reference("result"),
                  checkpoint: f.checkpoint("saved"),
                };
              }),
          }),
        );
        yield* f.offer("one");
        const first = yield* facet
          .run({ publisher: publisher(), requestId: "one" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const pending = yield* facet.run({ publisher: publisher(), requestId: "one" });
        expect(pending.action).toBe("observe-only");
        expect(turns).toBe(1);
        yield* Deferred.succeed(release, undefined);
        const committed = yield* Fiber.join(first);
        const retry = yield* facet.run({ publisher: publisher(), requestId: "one" });
        expect(retry).toEqual(committed);
        expect(turns).toBe(1);
      }),
  );

  it.effect("fences a detached old request and restores only after explicit reconciliation", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let oldEffects = 0;
      const old = yield* f.create(() =>
        Effect.succeed({
          run: (_input, context) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              yield* context.check;
              oldEffects += 1;
              return {
                status: "completed" as const,
                result: f.reference("old-result"),
                checkpoint: f.checkpoint("old"),
              };
            }),
        }),
      );
      yield* f.offer("old");
      const running = yield* old
        .run({ publisher: publisher(), requestId: "old" })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(started);
      const replacement = publisher("facet-two", 2);
      const replaced = yield* f.bind(replacement);
      expect(replaced.snapshot.requests?.entries[0]?.status).toBe("indeterminate");
      yield* Deferred.succeed(release, undefined);
      const stopped = yield* Fiber.join(running);
      expect(stopped._tag).toBe("Failure");
      expect(oldEffects).toBe(0);
      const unknown = yield* f.call({
        type: "request.reconcile",
        runId,
        controlKey,
        requestId: "old",
        evidence: f.reference("unknown"),
        outcome: { type: "unknown" },
      });
      expect(unknown.action).toBe("indeterminate");
      yield* f.call({
        type: "request.reconcile",
        runId,
        controlKey,
        requestId: "old",
        evidence: f.reference("native-proved-not-applied"),
        outcome: { type: "not-applied" },
      });
      let restored: HarnessRequestCheckpoint | undefined;
      const fresh = yield* f.create(
        (checkpoint) => {
          restored = checkpoint;
          return Effect.succeed({
            run: () =>
              Effect.succeed({
                status: "completed" as const,
                result: f.reference("fresh-result"),
                checkpoint: f.checkpoint("fresh"),
              }),
          });
        },
        { facetNonce: replacement.facetNonce },
      );
      yield* f.offer("new-explicit-id");
      const result = yield* fresh.run({ publisher: replacement, requestId: "new-explicit-id" });
      expect(restored).toEqual(f.initial);
      expect(result.action).toBe("committed");
      expect(result.snapshot.requests?.entries.map((entry) => entry.status)).toEqual([
        "not-applied",
        "completed",
      ]);
    }),
  );

  it.effect(
    "a lost finish reply is recovered from SQL without opening another native runtime",
    () =>
      Effect.gen(function* () {
        const f = yield* requestFacetFixture;
        const first = yield* f.create(
          () =>
            Effect.succeed({
              run: () =>
                Effect.succeed({
                  status: "completed" as const,
                  result: f.reference("result"),
                  checkpoint: f.checkpoint("saved"),
                }),
            }),
          {
            store: {
              execute: async (command) => {
                const result = await f.options.store.execute(command);
                if (
                  typeof command === "object" &&
                  command !== null &&
                  "type" in command &&
                  command.type === "request.finish"
                )
                  throw new Error("Committed reply was lost");
                return result;
              },
            },
          },
        );
        yield* f.offer("one");
        const failed = yield* first
          .run({ publisher: publisher(), requestId: "one" })
          .pipe(Effect.flip);
        expect(failed.cause).toBeInstanceOf(Error);
        const replacement = publisher("facet-two", 2);
        yield* f.bind(replacement);
        let opened = false;
        const fresh = yield* f.create(
          () => {
            opened = true;
            return Effect.die("Committed results must not reopen the native provider");
          },
          { facetNonce: replacement.facetNonce },
        );
        const result = yield* fresh.run({ publisher: replacement, requestId: "one" });
        expect(result.action).toBe("committed");
        expect(result.snapshot.requests?.checkpoint).toEqual(f.checkpoint("saved"));
        expect(opened).toBe(false);
      }),
  );

  it.effect("uses one settled host-prepared runtime after publication without calling open", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const nextPublisher = publisher("prepared-facet", 2);
      yield* f.bind(nextPublisher);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commands: string[] = [];
      let prepareCalls = 0;
      let openCalls = 0;
      let turns = 0;
      let runtimeClosed = false;
      const facet = yield* f.create(
        () => {
          openCalls++;
          return Effect.die("The prepared path must use its retained runtime.");
        },
        {
          facetNonce: nextPublisher.facetNonce,
          store: {
            execute: async (command) => {
              if (typeof command === "object" && command !== null && "type" in command)
                commands.push(String(command.type));
              return await f.options.store.execute(command);
            },
          },
          prepareInert: (input) =>
            Effect.gen(function* () {
              prepareCalls++;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              const checkpoint = f.initial;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  runtimeClosed = true;
                }),
              );
              return {
                facetNonce: input.targetFacetNonce,
                nativeSessionId: "observed-native-session",
                checkpoint,
                manifestRevision: checkpoint.filesystem.sha256,
                joined: { invocationRpc: true, fetch: true, ports: true },
                runtime: {
                  run: (_reference, context) =>
                    Effect.gen(function* () {
                      yield* context.check;
                      turns++;
                      return {
                        status: "completed" as const,
                        result: f.reference("prepared-runtime-result"),
                        checkpoint: f.checkpoint("prepared-runtime-finish"),
                      };
                    }),
                },
              };
            }),
        },
      );
      const input = {
        operationId: "replace-2",
        targetFacetNonce: nextPublisher.facetNonce,
        nativeSessionId: "observed-native-session",
        checkpointId: f.initial.native.id,
        manifestRevision: f.initial.filesystem.sha256,
        priorFacetNonce: publisher().facetNonce,
        expectedFacetGeneration: 1,
      };
      const first = yield* facet.prepareInert(input).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      expect(commands).not.toContain("request.admit");
      expect(openCalls).toBe(0);
      yield* Deferred.succeed(release, undefined);
      const observed = yield* Fiber.join(first);
      expect(yield* facet.prepareInert(input)).toEqual(observed);
      expect(prepareCalls).toBe(1);

      yield* f.offer("prepared-request");
      const result = yield* facet.run({ publisher: nextPublisher, requestId: "prepared-request" });
      expect(result.action).toBe("committed");
      expect({ turns, openCalls }).toEqual({ turns: 1, openCalls: 0 });
      yield* facet.dispose;
      expect(runtimeClosed).toBe(true);
    }),
  );

  it.effect("rejects missing or mismatched host preparation before request admission", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const nextPublisher = publisher("prepared-check", 2);
      yield* f.bind(nextPublisher);
      const input = {
        operationId: "replace-2",
        targetFacetNonce: nextPublisher.facetNonce,
        nativeSessionId: "observed-native-session",
        checkpointId: f.initial.native.id,
        manifestRevision: f.initial.filesystem.sha256,
        priorFacetNonce: publisher().facetNonce,
        expectedFacetGeneration: 1,
      };
      let openCalls = 0;
      const missing = yield* f.create(
        () => {
          openCalls++;
          return Effect.succeed({ run: () => Effect.die("missing callback must fail first") });
        },
        { facetNonce: nextPublisher.facetNonce },
      );
      const missingResult = yield* Effect.exit(missing.prepareInert(input));
      expect(Exit.isFailure(missingResult)).toBe(true);
      expect(openCalls).toBe(0);
      yield* missing.dispose;

      let cleanupCalls = 0;
      const mismatch = yield* f.create(
        () => {
          openCalls++;
          return Effect.die("mismatched preparation must fail before open");
        },
        {
          facetNonce: nextPublisher.facetNonce,
          prepareInert: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  cleanupCalls++;
                }),
              );
              return {
                facetNonce: nextPublisher.facetNonce,
                nativeSessionId: "observed-native-session",
                checkpoint: f.checkpoint("wrong-checkpoint"),
                manifestRevision: f.initial.filesystem.sha256,
                joined: { invocationRpc: true, fetch: true, ports: true },
                runtime: {
                  run: () => Effect.die("Mismatch must not invoke a runtime."),
                },
              };
            }),
        },
      );
      const mismatchFailure = yield* Effect.flip(mismatch.prepareInert(input));
      expect(mismatchFailure).toBeInstanceOf(HarnessRequestFacetError);
      expect(mismatchFailure.message).toBe(
        "Harness host preparation did not observe the requested identity and checkpoint.",
      );
      expect(mismatchFailure.cause).toBeUndefined();
      expect(openCalls).toBe(0);
      expect(cleanupCalls).toBe(1);
      yield* mismatch.dispose;
    }),
  );

  it.effect("fences stale nonce and generation before request admission", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const nextPublisher = publisher("prepared-stale", 2);
      yield* f.bind(nextPublisher);
      const commands: string[] = [];
      let turns = 0;
      const facet = yield* f.create(() => Effect.die("A prepared path must not call open."), {
        facetNonce: nextPublisher.facetNonce,
        store: {
          execute: async (command) => {
            if (typeof command === "object" && command !== null && "type" in command)
              commands.push(String(command.type));
            return await f.options.store.execute(command);
          },
        },
        prepareInert: (input) =>
          Effect.succeed({
            facetNonce: input.targetFacetNonce,
            nativeSessionId: "observed-native-session",
            checkpoint: f.initial,
            manifestRevision: f.initial.filesystem.sha256,
            joined: { invocationRpc: true, fetch: true, ports: true },
            runtime: {
              run: () =>
                Effect.sync(() => {
                  turns++;
                  return {
                    status: "completed" as const,
                    result: f.reference("never-run"),
                    checkpoint: f.initial,
                  };
                }),
            },
          }),
      });
      const input = {
        operationId: "replace-2",
        targetFacetNonce: nextPublisher.facetNonce,
        nativeSessionId: "observed-native-session",
        checkpointId: f.initial.native.id,
        manifestRevision: f.initial.filesystem.sha256,
        priorFacetNonce: publisher().facetNonce,
        expectedFacetGeneration: 1,
      };
      yield* facet.prepareInert(input);
      yield* f.offer("stale-request");
      const staleNonce = yield* Effect.exit(
        facet.run({ publisher: publisher("stale-facet", 2), requestId: "stale-request" }),
      );
      const staleGeneration = yield* Effect.exit(
        facet.run({
          publisher: publisher(nextPublisher.facetNonce, 3),
          requestId: "stale-request",
        }),
      );
      expect(Exit.isFailure(staleNonce)).toBe(true);
      expect(Exit.isFailure(staleGeneration)).toBe(true);
      expect(commands).not.toContain("request.admit");
      expect(turns).toBe(0);
      yield* facet.dispose;
    }),
  );

  it.effect("keeps failed preparation one-shot and closes its partially built scope", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const nextPublisher = publisher("prepared-failure", 2);
      const callbackCause = new HarnessRequestFacetError("Host preparation callback failed.");
      let callbackCalls = 0;
      let cleanupCalls = 0;
      const facet = yield* f.create(
        () => Effect.die("Preparation failure must not fall back to open."),
        {
          facetNonce: nextPublisher.facetNonce,
          prepareInert: () =>
            Effect.gen(function* () {
              callbackCalls++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  cleanupCalls++;
                }),
              );
              return yield* Effect.fail(callbackCause);
            }),
        },
      );
      const input = {
        operationId: "replace-2",
        targetFacetNonce: nextPublisher.facetNonce,
        nativeSessionId: "observed-native-session",
        checkpointId: f.initial.native.id,
        manifestRevision: f.initial.filesystem.sha256,
        priorFacetNonce: publisher().facetNonce,
        expectedFacetGeneration: 1,
      };
      const firstFailure = yield* Effect.flip(facet.prepareInert(input));
      expect(firstFailure).toBeInstanceOf(HarnessRequestFacetError);
      expect(firstFailure.message).toBe(
        "Harness host could not prepare the committed checkpoint inert.",
      );
      expect(firstFailure.cause).toBe(callbackCause);
      expect(Exit.isFailure(yield* Effect.exit(facet.prepareInert(input)))).toBe(true);
      expect({ callbackCalls, cleanupCalls }).toEqual({ callbackCalls: 1, cleanupCalls: 1 });
      yield* facet.dispose;
    }),
  );

  it.effect("retains a failed preparation scope when its cleanup finalizer also fails", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const nextPublisher = publisher("prepared-cleanup-failure", 2);
      const callbackCause = new HarnessRequestFacetError("Host callback failed.");
      const cleanupCause = new HarnessRequestFacetError("Host preparation cleanup failed.");
      let callbackCalls = 0;
      let cleanupCalls = 0;
      const ownerScope = yield* Scope.make();
      const facet = yield* Scope.provide(ownerScope)(
        f.create(() => Effect.die("Failed inert preparation must not fall back to open."), {
          facetNonce: nextPublisher.facetNonce,
          prepareInert: () =>
            Effect.gen(function* () {
              callbackCalls++;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  cleanupCalls++;
                  return yield* Effect.die(cleanupCause);
                }),
              );
              return yield* Effect.fail(callbackCause);
            }),
        }),
      );
      const input = {
        operationId: "replace-2",
        targetFacetNonce: nextPublisher.facetNonce,
        nativeSessionId: "observed-native-session",
        checkpointId: f.initial.native.id,
        manifestRevision: f.initial.filesystem.sha256,
        priorFacetNonce: publisher().facetNonce,
        expectedFacetGeneration: 1,
      };

      const firstFailure = yield* Effect.flip(facet.prepareInert(input));
      expect(firstFailure).toBeInstanceOf(HarnessRequestFacetError);
      expect(firstFailure.message).toBe("Harness preparation cleanup is unknown.");
      expect(firstFailure.cause).toBe(cleanupCause);

      const firstDisposeFailure = yield* Effect.exit(facet.dispose);
      const secondDisposeFailure = yield* Effect.exit(facet.dispose);
      expect(Exit.isFailure(firstDisposeFailure)).toBe(true);
      expect(secondDisposeFailure).toEqual(firstDisposeFailure);
      expect({ callbackCalls, cleanupCalls }).toEqual({ callbackCalls: 1, cleanupCalls: 1 });
      const ownerScopeClose = yield* Effect.exit(Scope.close(ownerScope, Exit.void));
      expect(Exit.isFailure(ownerScopeClose)).toBe(true);
      expect({ callbackCalls, cleanupCalls }).toEqual({ callbackCalls: 1, cleanupCalls: 1 });
    }),
  );

  it.effect("keeps one prepared runtime across checkpoint commits and cached-result retries", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const nextPublisher = publisher("prepared-checkpoint-advance", 2);
      yield* f.bind(nextPublisher);
      const firstCheckpoint = f.checkpoint("prepared-first-finish");
      const secondCheckpoint = f.checkpoint("prepared-second-finish");
      let prepareCalls = 0;
      let openCalls = 0;
      let turns = 0;
      const facet = yield* f.create(
        () => {
          openCalls++;
          return Effect.die("Prepared execution must retain its original runtime.");
        },
        {
          facetNonce: nextPublisher.facetNonce,
          prepareInert: (input) =>
            Effect.sync(() => {
              prepareCalls++;
              return {
                facetNonce: input.targetFacetNonce,
                nativeSessionId: input.nativeSessionId,
                checkpoint: f.initial,
                manifestRevision: f.initial.filesystem.sha256,
                joined: { invocationRpc: true, fetch: true, ports: true },
                runtime: {
                  run: () =>
                    Effect.sync(() => {
                      turns++;
                      return {
                        status: "completed" as const,
                        result: f.reference(`prepared-result-${turns}`),
                        checkpoint: turns === 1 ? firstCheckpoint : secondCheckpoint,
                      };
                    }),
                },
              };
            }),
        },
      );
      const input = {
        operationId: "replace-2",
        targetFacetNonce: nextPublisher.facetNonce,
        nativeSessionId: "prepared-native-session",
        checkpointId: f.initial.native.id,
        manifestRevision: f.initial.filesystem.sha256,
        priorFacetNonce: publisher().facetNonce,
        expectedFacetGeneration: 1,
      };
      yield* facet.prepareInert(input);

      yield* f.offer("prepared-first-request");
      const first = yield* facet.run({
        publisher: nextPublisher,
        requestId: "prepared-first-request",
      });
      expect(first.snapshot.requests?.checkpoint).toEqual(firstCheckpoint);
      const cached = yield* facet.run({
        publisher: nextPublisher,
        requestId: "prepared-first-request",
      });
      expect(cached).toEqual(first);
      expect(turns).toBe(1);

      const stalePublication = yield* Effect.exit(
        facet.run({
          publisher: publisher(nextPublisher.facetNonce, nextPublisher.generation + 1),
          requestId: "prepared-first-request",
        }),
      );
      expect(Exit.isFailure(stalePublication)).toBe(true);
      expect(turns).toBe(1);

      yield* f.offer("prepared-second-request");
      const second = yield* facet.run({
        publisher: nextPublisher,
        requestId: "prepared-second-request",
      });
      expect(second.action).toBe("committed");
      expect(second.snapshot.requests?.checkpoint).toEqual(secondCheckpoint);
      expect({ prepareCalls, openCalls, turns }).toEqual({
        prepareCalls: 1,
        openCalls: 0,
        turns: 2,
      });
      yield* facet.dispose;
    }),
  );
});
