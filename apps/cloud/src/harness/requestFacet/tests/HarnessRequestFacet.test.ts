import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
});
