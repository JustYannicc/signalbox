import type { AssetFetcher } from "../../../src/assets/ChunkedAsset.ts";
import { samePreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { openClaudeOwnerRelease } from "./fixture/claudeOwnerCode.ts";
import type { Configuration } from "./fixture/configuration.ts";
import { decodePreparedRelease } from "./preparedRelease.schema.ts";
import { createQualifierClaudeFacetEnvironment } from "./claudeFacetEnvironment.ts";

/**
 * Materializes the inert import calibration inside the real loader's lazy code callback. Claude
 * turns run on the product thread host, whose owners are its own facets; no C facet gets any.
 */
export async function prepareClaudeFacetCode(
  code: WorkerLoaderWorkerCode,
  configuration: Pick<Configuration, "claude">,
  assets: AssetFetcher,
  inputs: {
    readonly RUN_ID: string;
    readonly CONFIG_SHA256: string;
    readonly authorities: Parameters<typeof createQualifierClaudeFacetEnvironment>[3];
  },
) {
  if (
    code.mainModule !== "qualifier-claude-calibration-facet.mjs" ||
    code.env?.QUALIFIER_CLAUDE_FACET_MODE !== "inert-import-calibration"
  )
    throw new Error("DEPLOY3_CLAUDE_FACET_MODE_MISMATCH");
  const selected = decodePreparedRelease(code.env?.HARNESS_C_TARGET_PREPARED_RELEASE);
  const matches = (["baseline", "hooks"] as const).filter((variant) =>
    samePreparedRelease(selected, configuration.claude.expected[variant]),
  );
  const variant = matches.length === 1 ? matches[0] : undefined;
  if (!variant) throw new Error("DEPLOY3_CLAUDE_SELECTED_RELEASE_MISMATCH");
  const supplied: unknown = code.env?.QUALIFIER_CLAUDE_VARIANT;
  if (supplied !== undefined && supplied !== variant)
    throw new Error("DEPLOY3_CLAUDE_SELECTED_VARIANT_MISMATCH");
  const release = await openClaudeOwnerRelease(selected, configuration.claude, assets);
  const environment = createQualifierClaudeFacetEnvironment(
    code.env ?? {},
    { ...inputs, runtime: configuration.claude.runtime },
    variant,
    inputs.authorities,
  );
  return {
    variant,
    code: {
      ...code,
      env: environment,
      modules: {
        ...code.modules,
        ...(await release.modules(undefined)),
        "qualifier-claude-implementation.mjs": { js: configuration.claude.facetSource },
      },
    },
  };
}
