import { expect, it } from "vite-plus/test";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { createHarnessProcessFacetAdapter } from "../HarnessProcessFacetObject.ts";
import {
  serializeHarnessRequestFacetFailure,
  type HarnessRequestFacetFailure,
} from "../requestFacet/failure.ts";

it("restores the structured checkpoint failure after the facet RPC error", async () => {
  const nativeFailure = Object.assign(new Error("Codex fixture checkpoint restore failed."), {
    code: "CODEX_CHECKPOINT_RESTORE",
    operation: "resume",
  });
  const checkpointFailure = new HarnessRequestFacetError(
    "Harness host could not prepare the committed checkpoint inert.",
    { cause: nativeFailure },
  );
  const serializedFailure: HarnessRequestFacetFailure =
    serializeHarnessRequestFacetFailure(checkpointFailure);
  const facet = {
    identity: () => ({ facetNonce: "facet-nonce" }),
    async prepareInert() {
      throw new Error("The RPC boundary dropped the original cause.");
    },
    readPreparationFailure: () => serializedFailure,
    async run() {
      throw new Error("Invocation is outside this preparation-only probe.");
    },
    async dispose() {},
  };
  const adapter = createHarnessProcessFacetAdapter(
    { shardOwner: "shard", loaderId: "loader", facetKey: "facet" },
    facet,
  );

  const restored = await adapter
    .prepareInert({
      operationId: "operation",
      targetFacetNonce: "facet-nonce",
      nativeSessionId: "native-session",
      checkpointId: "checkpoint",
      manifestRevision: "manifest",
      priorFacetNonce: "prior-facet",
      expectedFacetGeneration: 0,
    })
    .then(
      () => {
        throw new Error("Expected the facet preparation to fail.");
      },
      (cause: unknown) => cause,
    );
  expect(restored).toBeInstanceOf(Error);
  if (!(restored instanceof Error)) throw new Error("Expected a restored facet error.");
  expect(restored.message).toBe("Harness host could not prepare the committed checkpoint inert.");
  expect("_tag" in restored && restored._tag).toBe("HarnessRequestFacetError");
  expect(restored.cause).toBeInstanceOf(Error);
  if (!(restored.cause instanceof Error))
    throw new Error("Expected the native restore error cause.");
  expect(restored.cause.message).toBe("Codex fixture checkpoint restore failed.");
  expect("code" in restored.cause && restored.cause.code).toBe("CODEX_CHECKPOINT_RESTORE");
  expect("operation" in restored.cause && restored.cause.operation).toBe("resume");
});
