import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import type { HarnessCProductTurnGrantSource } from "../HarnessCProductCapabilities.ts";
import { prepareProductFixture } from "./tests/prepare.fixture.ts";
import type { Grant } from "./tests/recordingHost.fixture.ts";

describe.each(["claude-code", "codex"] as const)("%s product facet preparation", (provider) => {
  it.effect.each(["same-variant-serialized-checkpoint", "cross-variant-fresh-boot"] as const)(
    "%s restores files before seeding and preserves native identity",
    (mode) =>
      Effect.gen(function* () {
        const fixture = yield* prepareProductFixture(provider, mode);
        const opened = fixture.openInputs[0]!;
        expect(fixture.seeded).toEqual(["assets", "programs"]);
        expect(opened.session.initialNativeThreadId).toBe(
          fixture.checkpoint.snapshot.providerThread.nativeThreadRef!.nativeId,
        );
        if (mode === "same-variant-serialized-checkpoint") {
          expect(opened.checkpoint).toEqual(fixture.checkpoint);
          expect(opened.initialAccess?.grant).toBe(fixture.initialAccesses[0]);
          expect(opened.initialAccess?.signal).toBe(fixture.preparationSignal);
          expect(fixture.initialAccesses).toHaveLength(1);
        } else {
          expect(opened.checkpoint).toBeUndefined();
          expect(opened.initialAccess).toBeUndefined();
          expect(fixture.initialAccesses).toEqual([]);
        }
        expect(fixture.prepared.evidence.checkpoint).toEqual(fixture.checkpointRefs);
        expect(fixture.checkpointWrites()).toBe(0);
        expect(fixture.turnAccesses).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("resolves a fresh grant for each later request and uses its local abort signal", () =>
    Effect.gen(function* () {
      const fixture = yield* prepareProductFixture(provider, "cross-variant-fresh-boot");
      const first = fixture.context("request-1");
      const second = fixture.context("request-2");
      yield* fixture.prepared.runtime.run(fixture.input, first).pipe(Effect.flip);
      yield* fixture.prepared.runtime.run(fixture.input, second).pipe(Effect.flip);
      expect(fixture.resolvedRequests).toEqual(["request-1", "request-2"]);
      expect(fixture.turnAccesses).toHaveLength(2);
      expect(fixture.observedTurnGrants.map((access) => access.grant)).toEqual(
        fixture.turnAccesses,
      );
      expect(fixture.turnAccesses[0]).not.toBe(fixture.turnAccesses[1]);
      expect(fixture.observedTurnGrants[0]!.signal.aborted).toBe(true);
      expect(first.signal.aborted).toBe(false);
      expect(second.signal.aborted).toBe(false);
      expect(fixture.initialAccesses).toEqual([]);
      expect(fixture.checkpointWrites()).toBe(0);
    }).pipe(Effect.scoped),
  );
  it.effect("wires the optional turn-grant source through the public product facet", () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const source: HarnessCProductTurnGrantSource<Grant> = {
        issue: async () => ({
          grant: { kind: "turn", requestId: "issued", call: 1 },
          endpoint: "https://tools-gateway.test/mcp",
          expiresAtMs: clock.currentTimeMillisUnsafe() + 60_000,
        }),
      };
      const fixture = yield* prepareProductFixture(provider, "cross-variant-fresh-boot", {
        turnGrantSource: source,
      });
      expect(fixture.observedTurnGrantSources).toEqual([source]);
      const context = fixture.context("publisher-turn");
      yield* fixture.prepared.runtime.run(fixture.input, context).pipe(Effect.flip);
      expect(fixture.observedTurnGrants[0]?.publisher).toEqual({
        generation: context.publisher.generation,
        facetNonce: context.publisher.facetNonce,
      });
      expect(fixture.observedTurnGrants[0]?.publisher?.facetNonce).toBe("facet-b");
    }).pipe(Effect.scoped),
  );
  it.effect(
    "resolves fresh access after inert checkpoint preparation and for every later request",
    () =>
      Effect.gen(function* () {
        const fixture = yield* prepareProductFixture(
          provider,
          "same-variant-serialized-checkpoint",
        );
        const first = fixture.context("restored-first");
        const second = fixture.context("later-request");
        yield* fixture.prepared.runtime.run(fixture.input, first).pipe(Effect.flip);
        yield* fixture.prepared.runtime.run(fixture.input, second).pipe(Effect.flip);
        expect(fixture.observedTurnGrants[0]!.grant).not.toBe(fixture.initialAccesses[0]);
        expect(fixture.observedTurnGrants[0]!.grant).toBe(fixture.turnAccesses[0]);
        expect(fixture.observedTurnGrants[0]!.signal.aborted).toBe(true);
        expect(fixture.resolvedRequests).toEqual(["restored-first", "later-request"]);
        expect(fixture.turnAccesses).toHaveLength(2);
        expect(fixture.observedTurnGrants[1]!.grant).toBe(fixture.turnAccesses[1]);
      }).pipe(Effect.scoped),
  );
  it.effect.each(["assets", "programs"] as const)(
    "joins the owned host after %s preparation fails",
    (failSeed) =>
      Effect.gen(function* () {
        let disposed = 0;
        const failure = yield* prepareProductFixture(provider, "cross-variant-fresh-boot", {
          failSeed,
          onDispose: () => {
            disposed++;
          },
        }).pipe(Effect.scoped, Effect.exit);
        expect(failure._tag).toBe("Failure");
        expect(disposed).toBe(1);
      }),
  );
  it.effect("rejects a provider open input that changes the committed native ID", () =>
    Effect.gen(function* () {
      let disposed = 0;
      const failure = yield* prepareProductFixture(provider, "cross-variant-fresh-boot", {
        openNativeSessionId: "another-native-id",
        onDispose: () => {
          disposed++;
        },
      }).pipe(Effect.scoped, Effect.exit);
      expect(failure._tag).toBe("Failure");
      expect(disposed).toBe(1);
    }),
  );
});
