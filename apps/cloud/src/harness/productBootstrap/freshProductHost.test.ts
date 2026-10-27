import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import { freshProductHostFixture } from "./tests/freshProductHost.fixture.ts";

describe("fresh product host", () => {
  it.effect(
    "creates Codex without prior checkpoint reads and runs on the retained native session",
    () =>
      Effect.gen(function* () {
        const fixture = yield* freshProductHostFixture;

        expect(fixture.facetOptions.loadedPreparedRelease?.()).toBe(fixture.source.expected);
        expect(fixture.evidence.nativeSessionId).toBe("123e4567-e89b-12d3-a456-426614174000");
        expect(fixture.evidence.filesCheckpoint).toEqual(fixture.initialFiles);
        expect(fixture.evidence.checkpoint).toEqual(fixture.requestCheckpoint);
        expect(fixture.evidence.joined).toEqual({ invocationRpc: true, fetch: true, ports: true });
        expect(fixture.initialCheckpoints).toEqual([fixture.currentCheckpoint]);
        expect(fixture.initialPublishers).toEqual([
          {
            generation: 1,
            facetNonce: "facet-fresh",
            publisherKey: "p".repeat(32),
          } satisfies HarnessThreadSupervisorPublisher,
        ]);
        expect(fixture.opened).toHaveLength(1);
        expect(fixture.opened[0]?.creation?.providerThread.nativeThreadRef).toBeNull();
        expect(fixture.opened[0]?.session.initialNativeThreadId).toBeUndefined();
        expect(fixture.opened[0]?.checkpoint).toBeUndefined();
        expect(fixture.opened[0]?.initialAccess?.grant).toEqual({ token: "initial" });
        expect(fixture.order.slice(0, 5)).toEqual([
          "seed:assets",
          "seed:programs",
          "fresh-access",
          "open",
          "retire",
        ]);
        expect(fixture.order.indexOf("write-initial")).toBeGreaterThan(
          fixture.order.indexOf("retire"),
        );
        expect(fixture.accessCalls).toEqual(["fresh:create-1"]);
        expect(fixture.verifyCalls).toContain("initial-checkpoint:native");
        expect(fixture.verifyCalls).toContain("initial-files:filesystem");

        const result = yield* fixture.evidence.runtime.run(fixture.firstInput, fixture.turnContext);
        expect(result.status).toBe("completed");
        expect(fixture.turnCalls).toBe(1);
        expect(fixture.exports).toBe(2);
        expect(fixture.opened).toHaveLength(1);
        expect(fixture.accessCalls).toEqual(["fresh:create-1", "turn:first-turn"]);
      }).pipe(Effect.scoped),
  );
});
