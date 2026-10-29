import { expect, it } from "vite-plus/test";
import { resolveClaudeReleaseVariants } from "../../../src/harnessReleases/ClaudeReleaseVariants.ts";
import { candidateProductReleaseVariants } from "./candidateVariants.ts";
import type { HarnessReleaseArtifact } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";

const artifact = (releaseId: string, fill: string): HarnessReleaseArtifact => ({
  provider: "claude-code",
  releaseId,
  artifactHash: fill.repeat(64),
  artifactRef: `sha256:${fill.repeat(64)}`,
  sourceIdentity: (fill === "a" ? "1" : "2").repeat(64),
  fixtureIdentity: "synthetic-input-only",
  createdAt: "2026-10-29T00:00:00.000Z",
});

it("derives an in-memory candidate catalog from actual ledger rows without qualification", () => {
  const baseline = artifact("synthetic-baseline", "a");
  const hooks = artifact("synthetic-hooks", "b");
  const result = candidateProductReleaseVariants({ baseline, hooks });

  expect(result.catalog.baseline.fullArtifact).toEqual(baseline);
  expect(result.catalog.hooks.fullArtifact).toEqual(hooks);
  expect(resolveClaudeReleaseVariants(result.catalog, result.variants.ledger)).toEqual(
    result.catalog,
  );
  expect(result.variants.ledger.getArtifact("claude-code", baseline.releaseId)).toEqual(baseline);
  expect(result.variants.ledger.getArtifact("codex", hooks.releaseId)).toBeNull();
});

it("fails closed when actual candidate ledger rows do not have distinct artifact identities", () => {
  const baseline = artifact("synthetic-baseline", "a");
  expect(() => candidateProductReleaseVariants({ baseline, hooks: baseline })).toThrow(
    "CLAUDE_VARIANTS_SHARED_releaseId",
  );
});
