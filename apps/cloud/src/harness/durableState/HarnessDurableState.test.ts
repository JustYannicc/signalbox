import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { HarnessFilesStoreError } from "../HarnessFilesStore.ts";
import {
  control1,
  control2,
  control3,
  createPublicationFixture,
  manifest0,
  preparedPublisher2,
  publisher1,
} from "./publicationFixture.ts";

describe("harness durable state composition", () => {
  it.effect("repairs a pending cross-store publication after control handoff", () =>
    Effect.gen(function* () {
      const { durable, supervisor, runId } = createPublicationFixture();
      const firstAttempt = yield* Effect.promise(() =>
        durable.publishFreshFacet({
          control: control2,
          operationId: "resume-1",
          verifiedNativeSessionId: "native-session-fixed",
          checkpoint: manifest0,
        }),
      );
      expect(firstAttempt).toMatchObject({
        status: "supervisor-pending",
        receipt: { status: "pending" },
      });
      yield* Effect.promise(() =>
        expect(
          supervisor.execute({ type: "read", runId, control: control2 }),
        ).rejects.toMatchObject({
          code: "STALE_CONTROL",
        }),
      );

      yield* Effect.promise(() =>
        durable.beginDrain({
          control: control2,
          publisher: publisher1,
          expectedGeneration: 1,
          operationId: "takeover-during-publication",
          nextControl: control3,
        }),
      );
      const repaired = yield* Effect.promise(() =>
        durable.publishFreshFacet({
          control: control3,
          operationId: "resume-1",
          verifiedNativeSessionId: "native-session-fixed",
          checkpoint: manifest0,
        }),
      );
      expect(repaired).toMatchObject({
        status: "published",
        receipt: {
          operationId: "resume-1",
          fromGeneration: 1,
          toGeneration: 2,
          priorFacetNonce: publisher1.facetNonce,
          preparedFacetNonce: preparedPublisher2.facetNonce,
          checkpoint: manifest0,
          status: "confirmed",
        },
        supervisor: {
          snapshot: {
            lifecycle: "published",
            nativeSessionId: "native-session-fixed",
            generation: 2,
          },
        },
      });
      yield* Effect.promise(() =>
        expect(
          durable.filesStore.execute({
            type: "readCheckpoint",
            runId,
            publisher: publisher1,
            checkpointId: manifest0.checkpointId,
          }),
        ).rejects.toMatchObject({ code: "STALE_PUBLISHER" }),
      );
    }),
  );

  it("does not expose controller-only file publication through the guest client", () => {
    const { durable } = createPublicationFixture();
    expect(() =>
      durable.filesStore.execute({
        type: "publishFacet",
        runId: "durable-run",
        control: control1,
        publisher: publisher1,
        expectedGeneration: 1,
        preparedPublisher: preparedPublisher2,
        operationId: "guest-publication",
        checkpoint: manifest0,
      } as never),
    ).toThrow(HarnessFilesStoreError);
  });
});
