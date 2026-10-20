import { describe, expect, it } from "@effect/vitest";
import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { publisher, requestFacetFixture, runId } from "../../requestFacet/tests/fixture.ts";
import { requestFixture } from "./fixture.ts";

describe("Harness native admissions", () => {
  it.effect.each(["ensureThread", "resumeThread"] as const)(
    "does not start native work after generation replacement during %s",
    (setup) =>
      Effect.gen(function* () {
        const f = yield* requestFixture;
        const store = yield* requestFacetFixture;
        yield* store.offer("native-turn");
        yield* store.call({
          type: "request.admit",
          runId,
          publisher: publisher(),
          requestId: "native-turn",
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let starts = 0;
        const build = f.instance.options.buildRuntime;
        f.setHost({
          buildRuntime: (input) =>
            build(input).pipe(
              Effect.map((native) => ({
                ...native,
                factory: {
                  open: (open) =>
                    native.factory.open(open).pipe(
                      Effect.map((runtime) => ({
                        ...runtime,
                        [setup]: () =>
                          Deferred.succeed(entered, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                            Effect.as({
                              ...f.instance.adapter.turn.providerThread,
                              nativeThreadRef: {
                                driver: runtime.driver,
                                nativeId: "restored",
                                strength: "strong" as const,
                              },
                            }),
                          ),
                        startTurn: (turn) =>
                          Effect.sync(() => {
                            starts++;
                          }).pipe(
                            Effect.andThen(
                              Effect.fail(
                                new ProviderAdapterTurnStartError({
                                  driver: runtime.driver,
                                  threadId: turn.threadId,
                                  providerThreadId: turn.providerThread.id,
                                  runId: turn.runId,
                                }),
                              ),
                            ),
                          ),
                      })),
                    ),
                },
              })),
            ),
        });
        const context = {
          ...f.context("native-turn"),
          publisher: publisher(),
          check: store
            .call({
              type: "request.check",
              runId,
              publisher: publisher(),
              requestId: "native-turn",
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) => new HarnessRequestFacetError("Store rejected old generation", { cause }),
              ),
            ),
        };
        const runtime = yield* f.open(context);
        const turn =
          setup === "ensureThread"
            ? f.instance.adapter.turn
            : {
                ...f.instance.adapter.turn,
                providerThread: {
                  ...f.instance.adapter.turn.providerThread,
                  nativeThreadRef: {
                    driver: f.instance.adapter.runtime.driver,
                    nativeId: "restored",
                    strength: "strong" as const,
                  },
                },
              };
        const reference = yield* f.input("native-input", turn);
        const running = yield* runtime
          .run(reference, context)
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        const replaced = yield* store.bind(publisher("replacement", 2));
        expect(replaced.snapshot.requests?.entries[0]?.status).toBe("indeterminate");
        yield* Deferred.succeed(release, undefined);
        expect(Result.isFailure(yield* Fiber.join(running))).toBe(true);
        expect(starts).toBe(0);
        expect(f.exports).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
});
