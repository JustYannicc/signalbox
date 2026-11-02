import { readRpcData } from "../../../../src/rpc/Resources.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../../src/harness/HarnessProcessResume.ts";
import {
  loadClaudeQualificationRuntime,
  readClaudeQualificationInputs,
} from "./claudeConfiguration.ts";
import type { readClaudeFacetConfiguration } from "./claudeFacetConfiguration.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { calibrateClaudePreparedRelease } from "./claudeCalibration.ts";
import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import { assert } from "./common.ts";

export async function observeClaudePreparedImport(input: {
  readonly ctx: DurableObjectState;
  readonly capability: QualifierCapabilities;
  readonly configuration: Awaited<ReturnType<typeof readClaudeFacetConfiguration>>;
  readonly assets: AssetFetcher;
  readonly release: HarnessProcessResumePreparedRelease | undefined;
  readonly facetNonce: string;
  readonly invocationId: string;
}) {
  const release = input.release;
  assert(
    release?.artifact.provider === "claude-code",
    "Calibration has no selected Claude release",
  );
  const { claude } = input.configuration;
  const qualification = await readClaudeQualificationInputs(claude, input.assets);
  const loaded = await loadClaudeQualificationRuntime(qualification, release.artifact);
  const imported = await calibrateClaudePreparedRelease({
    ctx: input.ctx,
    capability: input.capability,
    release: loaded,
    home: claude.seed.home,
  });
  const result = {
    incarnation: input.facetNonce,
    invocationId: input.invocationId,
    selectedReleaseId: release.artifact.releaseId,
    selectedReleaseHash: release.artifact.artifactHash,
    imported,
    nativeStarted: false as const,
  };
  await readRpcData(input.capability.append("claude-prepared-import-calibration", result));
  return result;
}
