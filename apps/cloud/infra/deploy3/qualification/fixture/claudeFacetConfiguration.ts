import { readRpcData } from "../../../../src/rpc/Resources.ts";
import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import type { QualifierClaudeInputs } from "../facetEnvironmentContract.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { readConfiguration } from "./configuration.ts";
import { decodeClaudeFacetConfiguration } from "./claudeConfiguration.ts";
import { assert } from "./common.ts";

export async function readClaudeFacetConfiguration(
  env: typeof QualifierClaudeInputs.Type & { readonly PROGRAM_ASSETS?: AssetFetcher },
  cap: Pick<QualifierCapabilities, "hostConfiguration">,
) {
  const host = await readRpcData(cap.hostConfiguration());
  const assets = env.PROGRAM_ASSETS;
  assert(assets, "Claude qualification has no public program asset binding");
  const raw = await readConfiguration(assets, env.CONFIG_SHA256);
  const variant = env.QUALIFIER_CLAUDE_VARIANT;
  const runtime = raw.claude.runtime;
  const claude = decodeClaudeFacetConfiguration({
    ...runtime,
    turnJson: runtime.turnJson[variant],
    seed: runtime.seed,
  });
  assert(host.runId === env.RUN_ID, "Claude qualifier run identity changed");
  return { host, claude, processEnvironment: env.QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT };
}
