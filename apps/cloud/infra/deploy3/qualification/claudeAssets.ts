import { readPinnedAsset, type AssetFetcher } from "../../../src/assets/ChunkedAsset.ts";
import {
  readHarnessReleaseDeployment,
  readHarnessReleaseQualificationInputs,
} from "../../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { validateClaudeReleaseVariantArtifacts } from "../../harnessReleases/claudeReleaseVariants.ts";
import { decodeDeploy3ClaudeAssets } from "./claudeAssets.schema.ts";

/** Build-time input validation; pending candidates use the public qualification reader. */
export async function loadDeploy3ClaudeAssets(raw: unknown, binding: AssetFetcher) {
  const input = decodeDeploy3ClaudeAssets(structuredClone(raw));
  if (input.assets.status !== "supplied") throw new Error("DEPLOY3_CLAUDE_ASSETS_AWAITING_PACKAGE");
  const { assets } = input;
  const read =
    assets.purpose === "qualification"
      ? readHarnessReleaseQualificationInputs
      : readHarnessReleaseDeployment;
  const opened = await read(binding, assets.metadata, assets.projectId);
  if (opened.claudeVariants === undefined) throw new Error("DEPLOY3_CLAUDE_VARIANTS_MISSING");
  const validated = await validateClaudeReleaseVariantArtifacts({
    catalog: opened.claudeVariants,
    ledger: opened.ledger,
    source: opened.source,
    baselinePin: assets.baselinePin,
    trustedComputer: assets.trustedComputer,
    maxPreparedModuleBytes: assets.maxPreparedModuleBytes,
  });
  // Graph inspection awaits I/O; recheck the same metadata pin before returning its inputs.
  await readPinnedAsset(binding, assets.metadata);
  return {
    purpose: assets.purpose,
    releasable: opened.releasable,
    projectId: assets.projectId,
    metadata: assets.metadata,
    releaseVariants: { catalog: validated.catalog, ledger: opened.ledger },
    source: opened.source,
    baseline: validated.baseline,
    hooks: validated.hooks,
    eligibility: {
      baseline: opened.ledger.getEligibility(
        "claude-code",
        validated.catalog.baseline.fullArtifact.releaseId,
      ),
      hooks: opened.ledger.getEligibility(
        "claude-code",
        validated.catalog.hooks.fullArtifact.releaseId,
      ),
    },
    openFindings: {
      baseline: opened.ledger.getOpenFindings(
        "claude-code",
        validated.catalog.baseline.fullArtifact.releaseId,
      ),
      hooks: opened.ledger.getOpenFindings(
        "claude-code",
        validated.catalog.hooks.fullArtifact.releaseId,
      ),
    },
    trustedComputer: assets.trustedComputer,
    maxPreparedModuleBytes: assets.maxPreparedModuleBytes,
  };
}
