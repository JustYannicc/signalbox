import type { AssetFetcher } from "../../../src/assets/ChunkedAsset.ts";
import { loadHarnessRelease } from "../../../src/harness/HarnessReleaseLoader.ts";
import { materializeHarnessProcessModules } from "../../../src/harness/HarnessProcessPlacement.ts";
import { samePreparedRelease } from "../../../src/harness/ProductHarnessProcessRelease.ts";
import { claudePreparedWorkerModules } from "./fixture/claudePreparedModules.ts";
import { readAsset, type Configuration } from "./fixture/configuration.ts";
import { decodePreparedRelease } from "./preparedRelease.schema.ts";
import { readClaudeQualificationAssets } from "./runtimeAssets.ts";
import { createQualifierClaudeFacetEnvironment } from "./claudeFacetEnvironment.ts";

/** Materializes verified modules inside the real loader's lazy code callback. */
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
  const selected = decodePreparedRelease(code.env?.HARNESS_C_TARGET_PREPARED_RELEASE);
  const matches = (["baseline", "hooks"] as const).filter((variant) =>
    samePreparedRelease(selected, configuration.claude.expected[variant]),
  );
  const variant = matches.length === 1 ? matches[0] : undefined;
  if (!variant) throw new Error("DEPLOY3_CLAUDE_SELECTED_RELEASE_MISMATCH");
  const supplied: unknown = code.env?.QUALIFIER_CLAUDE_VARIANT;
  if (supplied !== undefined && supplied !== variant)
    throw new Error("DEPLOY3_CLAUDE_SELECTED_VARIANT_MISMATCH");
  const opened = await readClaudeQualificationAssets(configuration.claude.runtime.assets, assets);
  const loaded = await loadHarnessRelease({
    identity: {
      artifactRef: selected.artifact.artifactRef,
      artifactHash: selected.artifact.artifactHash,
      sourceIdentity: selected.artifact.sourceIdentity,
    },
    source: opened.source,
    ...opened.loaderConfig,
  });
  if (loaded.plan.harness !== "claude-code") throw new Error("DEPLOY3_CLAUDE_PLAN_MISMATCH");
  const packages: Record<string, string> = {};
  for (const [name, pin] of Object.entries(configuration.claude.environmentPackages))
    packages[name] = new TextDecoder("utf-8", { fatal: true }).decode(await readAsset(assets, pin));
  const prepared = await claudePreparedWorkerModules(
    { artifact: selected.artifact, plan: loaded.plan },
    packages,
  );
  const readRange = opened.source.readRange;
  if (!readRange) throw new Error("DEPLOY3_CLAUDE_RANGE_READER_MISSING");
  const modules = await materializeHarnessProcessModules(prepared, selected, readRange);
  return {
    variant,
    code: {
      ...code,
      env: createQualifierClaudeFacetEnvironment(
        code.env ?? {},
        inputs,
        variant,
        inputs.authorities,
      ),
      modules: {
        ...code.modules,
        ...modules,
        "qualifier-claude-implementation.mjs": { js: configuration.claude.facetSource },
      },
    },
  };
}
