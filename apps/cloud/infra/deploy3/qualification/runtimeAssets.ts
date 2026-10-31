import type { AssetFetcher } from "../../../src/assets/ChunkedAsset.ts";
import { readHarnessReleaseQualificationInputs } from "../../../src/harnessReleases/HarnessReleaseDeployment.ts";
import { decodeDeploy3ClaudeAssets } from "./claudeAssets.schema.ts";

/** Pending candidate records stay behind the qualification reader in the deployed fixture. */
export async function readClaudeQualificationAssets(raw: unknown, binding: AssetFetcher) {
  const input = decodeDeploy3ClaudeAssets(structuredClone(raw));
  if (input.assets.status !== "supplied" || input.assets.purpose !== "qualification")
    throw new Error("DEPLOY3_QUALIFICATION_ASSETS_REQUIRED");
  const opened = await readHarnessReleaseQualificationInputs(
    binding,
    input.assets.metadata,
    input.assets.projectId,
  );
  if (!opened.claudeVariants) throw new Error("DEPLOY3_CLAUDE_VARIANTS_MISSING");
  return {
    ...opened,
    claudeVariants: opened.claudeVariants,
    loaderConfig: {
      trustedComputer: input.assets.trustedComputer,
      maxPreparedModuleBytes: input.assets.maxPreparedModuleBytes,
    },
  };
}
