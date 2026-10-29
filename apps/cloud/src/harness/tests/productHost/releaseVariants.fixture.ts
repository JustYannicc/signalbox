import type { HarnessReleaseArtifact } from "../../../harnessReleases/HarnessReleaseLedger.ts";
import type { LoadHarnessReleaseOptions } from "../../HarnessReleaseLoader.ts";
import type { ProductClaudeReleaseVariants } from "../../ProductClaudeReleaseSelection.ts";
import { claudeFixture } from "../../releaseLoader/tests/artifactFixtures.ts";

export function claudeReleaseArtifact(
  identity: LoadHarnessReleaseOptions["identity"],
  releaseId: string,
): HarnessReleaseArtifact {
  return {
    provider: "claude-code",
    releaseId,
    artifactRef: identity.artifactRef,
    artifactHash: identity.artifactHash,
    sourceIdentity: identity.sourceIdentity,
    fixtureIdentity: "product-claude-fixture",
    createdAt: "2026-10-29T00:00:00.000Z",
  };
}

export function claudeReleaseVariantsForArtifact(
  baseline: HarnessReleaseArtifact,
  suppliedHooks?: HarnessReleaseArtifact,
): ProductClaudeReleaseVariants {
  const hooks: HarnessReleaseArtifact = suppliedHooks ?? {
    ...baseline,
    releaseId: `${baseline.releaseId}-hooks`,
    artifactRef: `sha256:${"0".repeat(64)}`,
    artifactHash: "0".repeat(64),
    sourceIdentity: "1".repeat(64),
  };
  const records = [baseline, hooks];
  return {
    catalog: {
      baseline: { variant: "baseline", fullArtifact: baseline },
      hooks: { variant: "hooks", fullArtifact: hooks },
    },
    ledger: {
      getArtifact: (provider, releaseId) =>
        provider === "claude-code"
          ? (records.find((artifact) => artifact.releaseId === releaseId) ?? null)
          : null,
    },
  };
}

export async function claudeReleaseVariantsFixture() {
  const baseline = await claudeFixture();
  const hooks = await claudeFixture({ sourceIdentity: "e".repeat(64) });
  const baselineArtifact = claudeReleaseArtifact(baseline.options.identity, "baseline");
  const hooksArtifact = claudeReleaseArtifact(hooks.options.identity, "hooks");
  return {
    baseline,
    hooks,
    baselineArtifact,
    hooksArtifact,
    releaseVariants: claudeReleaseVariantsForArtifact(baselineArtifact, hooksArtifact),
    release: {
      ...baseline.options,
      source: {
        read: (ref: string, path: string) =>
          ref === baseline.options.identity.artifactRef
            ? baseline.options.source.read(ref, path)
            : hooks.options.source.read(ref, path),
      },
    },
  };
}
