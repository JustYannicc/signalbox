import { readRpcData } from "../../../../src/rpc/Resources.ts";
import type { QualifierClaudeInputs } from "../facetEnvironmentContract.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { decodeClaudeFacetConfiguration } from "./claudeConfiguration.ts";
import { assert } from "./common.ts";

/** The shard verified and parsed the qualifier configuration; this facet only gets its own section. */
export async function readClaudeFacetConfiguration(
  env: typeof QualifierClaudeInputs.Type,
  cap: Pick<QualifierCapabilities, "hostConfiguration">,
) {
  const host = await readRpcData(cap.hostConfiguration());
  const variant = env.QUALIFIER_CLAUDE_VARIANT;
  const runtime = env.QUALIFIER_CLAUDE_RUNTIME;
  const claude = decodeClaudeFacetConfiguration({
    ...runtime,
    turnJson: runtime.turnJson[variant],
    seed: runtime.seed,
  });
  assert(host.runId === env.RUN_ID, "Claude qualifier run identity changed");
  return { host, claude, processEnvironment: env.QUALIFIER_CLAUDE_PROCESS_ENVIRONMENT };
}
