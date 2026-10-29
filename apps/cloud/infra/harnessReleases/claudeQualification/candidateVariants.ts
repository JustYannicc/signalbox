import {
  decodeClaudeReleaseVariants,
  type ClaudeReleaseVariants,
} from "../../../src/harnessReleases/ClaudeReleaseVariants.ts";
import type {
  HarnessReleaseArtifact,
  HarnessReleaseLedger,
} from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type { ProductClaudeReleaseVariants } from "../../../src/harness/ProductClaudeReleaseSelection.ts";
import type { ClaudeQualificationVariant } from "./contracts.ts";

export type CandidateArtifactRows = Readonly<
  Record<ClaudeQualificationVariant, HarnessReleaseArtifact>
>;

/** Builds an in-memory candidate catalog from the rows read from candidate ledger storage. */
export function candidateProductReleaseVariants(rows: CandidateArtifactRows): {
  readonly variants: ProductClaudeReleaseVariants;
  readonly catalog: ClaudeReleaseVariants;
} {
  const catalog = decodeClaudeReleaseVariants({
    baseline: { variant: "baseline", fullArtifact: rows.baseline },
    hooks: { variant: "hooks", fullArtifact: rows.hooks },
  });
  const byReleaseId = new Map(
    [rows.baseline, rows.hooks].map((artifact) => [artifact.releaseId, artifact] as const),
  );
  const ledger: Pick<HarnessReleaseLedger, "getArtifact"> = {
    getArtifact(provider, releaseId) {
      if (provider !== "claude-code") return null;
      return byReleaseId.get(releaseId) ?? null;
    },
  };
  return { catalog, variants: { catalog, ledger } };
}
