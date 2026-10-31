import { ClaudeSeedConfiguration } from "./configuration.schema.ts";
import { ClaudeMcpProbe } from "./claudeMcpProbe.ts";
import * as Schema from "effect/Schema";
import { readClaudeQualificationAssets } from "../runtimeAssets.ts";
import { Deploy3ClaudeAssets, decodeDeploy3ClaudeAssets } from "../claudeAssets.schema.ts";
import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import { loadHarnessRelease } from "../../../../src/harness/HarnessReleaseLoader.ts";
import type { HarnessReleaseArtifact } from "../../../../src/harnessReleases/HarnessReleaseLedger.ts";
import { sameClaudeReleaseArtifact } from "../../../../src/harnessReleases/ClaudeReleaseVariants.ts";
import type { ProductClaudeReleaseVariants } from "../../../../src/harness/ProductClaudeReleaseSelection.ts";
import type { ClaudePreparedRelease } from "./claudePreparedModules.ts";

const NonEmpty = Schema.String.check(Schema.isPattern(/\S/u));

export const CLAUDE_QUALIFICATION_CONFIG_SCHEMA = "sb1070/deploy3-claude-facet/v1" as const;
export const CLAUDE_QUALIFICATION_API_REVISION = "EC1APIr2" as const;

type Deploy3ClaudeAssetBundle = typeof Deploy3ClaudeAssets.Type;
type SuppliedClaudeAssets = Extract<
  Deploy3ClaudeAssetBundle["assets"],
  { readonly status: "supplied" }
>;

export type ClaudeQualificationAssetBundle = Omit<Deploy3ClaudeAssetBundle, "assets"> & {
  readonly assets: SuppliedClaudeAssets & { readonly purpose: "qualification" };
};

const ClaudeFacetConfigurationSchema = Schema.Struct({
  schema: Schema.Literal(CLAUDE_QUALIFICATION_CONFIG_SCHEMA),
  purpose: Schema.Literal("qualification"),
  assets: Deploy3ClaudeAssets,
  workload: Schema.Struct({
    collectorNonce: NonEmpty,
    mcpProbe: ClaudeMcpProbe,
    apiRevision: Schema.Literal(CLAUDE_QUALIFICATION_API_REVISION),
    model: NonEmpty,
  }),
  turnJson: Schema.Array(NonEmpty),
  seed: ClaudeSeedConfiguration,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export interface ClaudeFacetConfiguration {
  readonly schema: typeof CLAUDE_QUALIFICATION_CONFIG_SCHEMA;
  readonly purpose: "qualification";
  readonly assets: ClaudeQualificationAssetBundle;
  readonly workload: {
    readonly collectorNonce: string;
    readonly mcpProbe: ClaudeMcpProbe;
    readonly apiRevision: typeof CLAUDE_QUALIFICATION_API_REVISION;
    readonly model: string;
  };
  readonly turnJson: readonly string[];
  readonly seed: {
    readonly home: string;
    readonly cwd: "/workspace";
  };
}

const decodeConfiguration = Schema.decodeUnknownSync(ClaudeFacetConfigurationSchema, {
  onExcessProperty: "error",
  reportInput: false,
});

export function decodeClaudeFacetConfiguration(input: unknown): ClaudeFacetConfiguration {
  const decoded = decodeConfiguration(input);
  if (decoded.turnJson.length === 0) throw new Error("DEPLOY3_CLAUDE_TURN_INPUT_MISSING");
  const assets = decodeDeploy3ClaudeAssets(decoded.assets);
  if (assets.assets.status !== "supplied" || assets.assets.purpose !== "qualification")
    throw new Error("DEPLOY3_CLAUDE_QUALIFICATION_ASSETS_REQUIRED");
  return {
    ...decoded,
    assets: assets as ClaudeQualificationAssetBundle,
  };
}

export interface ClaudeQualificationInputs {
  readonly purpose: "qualification";
  readonly releaseVariants: Omit<ProductClaudeReleaseVariants, "catalog"> & {
    readonly catalog: Awaited<ReturnType<typeof readClaudeQualificationAssets>>["claudeVariants"];
  };
  readonly source: Awaited<ReturnType<typeof readClaudeQualificationAssets>>["source"];
  readonly loaderConfig: Awaited<ReturnType<typeof readClaudeQualificationAssets>>["loaderConfig"];
}

/** Opens catalog and artifact access through the runtime public qualification reader. */
export async function readClaudeQualificationInputs(
  configuration: ClaudeFacetConfiguration,
  binding: AssetFetcher,
): Promise<ClaudeQualificationInputs> {
  const opened = await readClaudeQualificationAssets(configuration.assets, binding);
  return {
    purpose: "qualification",
    releaseVariants: { catalog: opened.claudeVariants, ledger: opened.ledger },
    source: opened.source,
    loaderConfig: opened.loaderConfig,
  };
}

/** Loads all selected CLI and SDK modules through the normal public release loader. */
export async function loadClaudeQualificationRelease(
  input: ClaudeQualificationInputs,
  artifact: HarnessReleaseArtifact,
): Promise<ClaudePreparedRelease> {
  const catalog = input.releaseVariants.catalog;
  const selected = [catalog.baseline.fullArtifact, catalog.hooks.fullArtifact].find((candidate) =>
    sameClaudeReleaseArtifact(candidate, artifact),
  );
  if (!selected) throw new Error("DEPLOY3_CLAUDE_RELEASE_OUTSIDE_QUALIFICATION_CATALOG");
  const loaded = await loadHarnessRelease({
    identity: {
      artifactRef: artifact.artifactRef,
      artifactHash: artifact.artifactHash,
      sourceIdentity: artifact.sourceIdentity,
    },
    source: input.source,
    trustedComputer: input.loaderConfig.trustedComputer,
    maxPreparedModuleBytes: input.loaderConfig.maxPreparedModuleBytes,
  });
  if (loaded.plan.harness !== "claude-code")
    throw new Error("DEPLOY3_CLAUDE_RELEASE_PROVIDER_MISMATCH");
  return { artifact: selected, plan: loaded.plan };
}
