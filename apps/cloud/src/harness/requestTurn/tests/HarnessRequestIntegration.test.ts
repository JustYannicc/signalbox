import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { createHarnessRequestFacet, HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { createHarnessRequestTurn } from "../../HarnessRequestTurn.ts";
import { controlKey, fixture, initial, runId, supervisor } from "../../runStore/tests/fixture.ts";
import { install, requestPublisher } from "../../runStore/tests/requestFixture.ts";
import { requestFixture } from "./fixture.ts";

const integration = Effect.gen(function* () {
  const driver = yield* requestFixture;
  const database = fixture();
  let client = database.open();
  const execute = (command: unknown) => client.call(command);
  const call = (command: unknown) =>
    Effect.tryPromise({
      try: () => execute(command),
      catch: (cause) => new HarnessRequestFacetError("Integration store failed", { cause }),
    });
  yield* call(initial);
  yield* call({
    type: "request.mode",
    runId,
    controlKey,
    requestId: "request-mode",
    checkpoint: driver.initial,
  });
  yield* call(install());
  const requestId = "integrated-turn";
  yield* call({
    type: "request.offer",
    runId,
    supervisor,
    request: { requestId, input: driver.firstInput },
  });
  const facet = yield* createHarnessRequestFacet({
    runId,
    facetNonce: requestPublisher().facetNonce,
    store: { execute },
    verify: driver.verify,
    open: createHarnessRequestTurn(driver.options),
  });
  const run = facet.run({ requestId, publisher: requestPublisher() });
  return {
    driver,
    facet,
    call,
    run,
    reopen: () => {
      client.close();
      client = database.open();
    },
  };
});

describe("Harness request composition", () => {
  it.effect(
    "commits the native terminal and checkpoint before returning and survives store reopen",
    () =>
      Effect.gen(function* () {
        const f = yield* integration;
        const publishing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        f.driver.setPublication((item) =>
          item.kind === "provider" && item.event.type === "turn.terminal"
            ? Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const running = yield* f.run.pipe(Effect.forkScoped);
        yield* f.driver.instance.adapter.nextStart;
        yield* f.driver.instance.adapter.terminal();
        yield* Deferred.await(publishing);
        const pending = yield* f.call({ type: "read", runId });
        expect(pending.snapshot.requests?.entries[0]?.status).toBe("admitted");
        expect(pending.snapshot.requests?.entries[0]?.finish).toBe(null);
        expect(f.driver.exports).toHaveLength(0);
        yield* Deferred.succeed(release, undefined);
        const finished = yield* Fiber.join(running);
        expect(finished.action).toBe("committed");
        const entry = finished.snapshot.requests?.entries[0];
        expect(entry?.status).toBe("completed");
        expect(entry?.finish?.status).toBe("completed");
        expect(f.driver.nativeOpens).toBe(1);
        expect(f.driver.terminals).toHaveLength(1);
        expect(f.driver.exports).toHaveLength(1);
        expect(f.driver.exports[0]?.revision.commit).toBe("computer-revision");
        f.reopen();
        const restored = yield* f.call({ type: "read", runId });
        expect(restored.snapshot.requests).toEqual(finished.snapshot.requests);
        const duplicate = yield* f.run;
        expect(duplicate.action).toBe("committed");
        expect(duplicate.snapshot.requests).toEqual(finished.snapshot.requests);
        expect(f.driver.terminals).toHaveLength(1);
        expect(f.driver.nativeOpens).toBe(1);
        yield* f.facet.dispose;
        expect(f.driver.signals[0]?.aborted).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("fences an admitted native turn when its facet generation is replaced", () =>
    Effect.gen(function* () {
      const f = yield* integration;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const build = f.driver.instance.options.buildRuntime;
      let starts = 0;
      f.driver.setHost({
        buildRuntime: (input) =>
          build(input).pipe(
            Effect.map((native) => ({
              ...native,
              factory: {
                open: (open) =>
                  native.factory.open(open).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      ensureThread: () =>
                        Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.as(f.driver.instance.adapter.turn.providerThread),
                        ),
                      startTurn: (turn) =>
                        Effect.sync(() => {
                          starts++;
                        }).pipe(Effect.andThen(runtime.startTurn(turn))),
                    })),
                  ),
              },
            })),
          ),
      });
      const running = yield* f.run.pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      const replaced = yield* f.call(install(2));
      expect(replaced.snapshot.requests?.entries[0]?.status).toBe("indeterminate");
      yield* Deferred.succeed(release, undefined);
      expect(Result.isFailure(yield* Fiber.join(running))).toBe(true);
      expect(starts).toBe(0);
      expect(f.driver.exports).toHaveLength(0);
      expect(f.driver.terminals).toHaveLength(0);
      f.reopen();
      const restored = yield* f.call({ type: "read", runId });
      expect(restored.snapshot.requests?.entries[0]?.status).toBe("indeterminate");
      expect(restored.snapshot.requests?.entries[0]?.finish).toBe(null);
      yield* f.facet.dispose;
    }).pipe(Effect.scoped),
  );
});
