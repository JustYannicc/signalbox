import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import { publisher, requestFacetFixture } from "./fixture.ts";

describe("cold request facet creation", () => {
  it.effect("retains the created native runtime for request one without restoring", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      let starts = 0;
      let turns = 0;
      let closes = 0;
      const facet = yield* f.create(
        () => Effect.die("Cold turn one must reuse the created runtime"),
        {
          startFresh: () =>
            Effect.gen(function* () {
              starts++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closes++;
                }),
              );
              return {
                facetNonce: publisher().facetNonce,
                nativeSessionId: "019c6818-87de-7312-a8e4-e691f15edaf7",
                checkpoint: f.initial,
                filesCheckpoint: {
                  checkpointId: f.initial.native.id,
                  parentCheckpointId: null,
                  files: [],
                },
                manifestRevision: f.initial.filesystem.sha256,
                joined: { invocationRpc: true, fetch: true, ports: true },
                runtime: {
                  run: () =>
                    Effect.sync(() => {
                      turns++;
                      return {
                        status: "completed" as const,
                        result: f.reference("result"),
                        checkpoint: f.checkpoint("after-one"),
                      };
                    }),
                },
              };
            }),
        },
      );
      const request = {
        operationId: "replace-1",
        targetFacetNonce: publisher().facetNonce,
        publisherKey: publisher().publisherKey,
      };
      const created = yield* facet.startFresh(request);
      expect(created.nativeSessionId).toBe("019c6818-87de-7312-a8e4-e691f15edaf7");
      expect(yield* facet.startFresh(request)).toEqual(created);
      expect({ starts, turns, closes }).toEqual({ starts: 1, turns: 0, closes: 0 });
      yield* f.offer("one");
      expect((yield* facet.run({ publisher: publisher(), requestId: "one" })).action).toBe(
        "committed",
      );
      expect({ starts, turns, closes }).toEqual({ starts: 1, turns: 1, closes: 0 });
      const changed = yield* facet
        .startFresh({ ...request, operationId: "another" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(changed)).toBe(true);
      yield* facet.dispose;
      expect(closes).toBe(1);
    }),
  );

  it.effect("rejects a fresh RPC aimed at another constructor before native creation", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      let starts = 0;
      const facet = yield* f.create(() => Effect.die("Unexpected restore"), {
        startFresh: () =>
          Effect.sync(() => {
            starts++;
            throw new Error("Unexpected native start");
          }),
      });
      const result = yield* facet
        .startFresh({
          operationId: "create",
          targetFacetNonce: "wrong",
          publisherKey: publisher().publisherKey,
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(starts).toBe(0);
    }),
  );
  it.effect("keeps failed native cleanup visible to the placement owner", () =>
    Effect.gen(function* () {
      const f = yield* requestFacetFixture;
      const ownerScope = yield* Scope.make();
      let starts = 0;
      let closes = 0;
      const facet = yield* f
        .create(() => Effect.die("Unexpected restore"), {
          startFresh: () =>
            Effect.gen(function* () {
              starts++;
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  closes++;
                  return yield* Effect.die("Unknown native cleanup");
                }),
              );
              return yield* Effect.fail(new HarnessRequestFacetError("Native startup failed"));
            }),
        })
        .pipe(Scope.provide(ownerScope));
      const request = {
        operationId: "create",
        targetFacetNonce: publisher().facetNonce,
        publisherKey: publisher().publisherKey,
      };
      expect(Exit.isFailure(yield* facet.startFresh(request).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* facet.startFresh(request).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* facet.dispose.pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* Scope.close(ownerScope, Exit.void).pipe(Effect.exit))).toBe(
        true,
      );
      expect({ starts, closes }).toEqual({ starts: 1, closes: 1 });
    }),
  );
});
