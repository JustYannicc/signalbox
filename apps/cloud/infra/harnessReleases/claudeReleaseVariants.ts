import * as NodeFSP from "node:fs/promises";
import {
  encodeClaudeReleaseVariants,
  resolveClaudeReleaseVariants,
} from "../../src/harnessReleases/ClaudeReleaseVariants.ts";
import {
  openHarnessReleaseArtifact,
  type HarnessReleaseArtifactIdentity,
  type HarnessReleaseArtifactSource,
} from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { HarnessReleaseLedger } from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import {
  loadHarnessRelease,
  type LoadHarnessReleaseOptions,
} from "../../src/harness/HarnessReleaseLoader.ts";
import type { PreparedReleaseModule } from "../../src/harness/HarnessReleasePlan.ts";

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
};
const same = (left: unknown, right: unknown, name: string) => {
  if (left === undefined || right === undefined || canonical(left) !== canonical(right))
    throw new Error(`CLAUDE_VARIANTS_${name}_MISMATCH`);
};
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLAUDE_VARIANTS_PROVENANCE_MISSING");
  return value as Record<string, unknown>;
};

export interface ClaudeBaselinePin {
  readonly identity: HarnessReleaseArtifactIdentity;
  /** Copied from the measured baseline graph, never inferred from a missing variant field. */
  readonly preparedModules: Readonly<Record<string, PreparedReleaseModule>>;
}

/** Producer validation opens both graphs outside the facet. It does not select or qualify them. */
export async function validateClaudeReleaseVariantArtifacts(input: {
  readonly catalog: unknown;
  readonly ledger: Pick<HarnessReleaseLedger, "getArtifact" | "getEligibility">;
  readonly source: HarnessReleaseArtifactSource;
  readonly baselinePin: ClaudeBaselinePin;
  readonly trustedComputer: LoadHarnessReleaseOptions["trustedComputer"];
  readonly maxPreparedModuleBytes: number;
}) {
  const catalog = resolveClaudeReleaseVariants(input.catalog, input.ledger);
  const baselineArtifact = catalog.baseline.fullArtifact;
  for (const field of ["artifactRef", "artifactHash", "sourceIdentity"] as const)
    same(baselineArtifact[field], input.baselinePin.identity[field], "BASELINE_PIN");
  const inspect = async (entry: typeof catalog.baseline | typeof catalog.hooks) => {
    const identity = {
      artifactRef: entry.fullArtifact.artifactRef,
      artifactHash: entry.fullArtifact.artifactHash,
      sourceIdentity: entry.fullArtifact.sourceIdentity,
    };
    const qualification = input.ledger.getEligibility("claude-code", entry.fullArtifact.releaseId);
    if (qualification.status === "rejected") throw new Error("CLAUDE_VARIANTS_REJECTED_PROOF");
    const opened = await openHarnessReleaseArtifact(identity, input.source);
    const loaded = await loadHarnessRelease({
      identity,
      source: input.source,
      trustedComputer: input.trustedComputer,
      maxPreparedModuleBytes: input.maxPreparedModuleBytes,
    });
    if (loaded.plan.harness !== "claude-code") throw new Error("CLAUDE_VARIANTS_PROVIDER_MISMATCH");
    return { plan: loaded.plan, manifests: opened.rawManifests, qualification };
  };
  const baseline = await inspect(catalog.baseline);
  const hooks = await inspect(catalog.hooks);
  same(baseline.plan.preparedModules, input.baselinePin.preparedModules, "BASELINE_MODULES");
  if (
    Object.keys(baseline.plan.workerEntries).length !== 0 ||
    Object.keys(baseline.plan.preparedModules).some((name) => name.includes("worker-hooks"))
  )
    throw new Error("CLAUDE_VARIANTS_BASELINE_HAS_FACTORY");
  if (
    Object.keys(hooks.plan.workerEntries).length !== 1 ||
    !hooks.plan.workerEntries["hooks-worker"]
  )
    throw new Error("CLAUDE_VARIANTS_HOOKS_FACTORY_MISSING");
  same(baseline.plan.cli, hooks.plan.cli, "OFFICIAL_CLI");
  same(baseline.plan.sdk, hooks.plan.sdk, "SDK");
  same(baseline.manifests.sdk, hooks.manifests.sdk, "SDK_GRAPH");
  same(baseline.plan.computer, hooks.plan.computer, "COMPUTER");
  same(
    baseline.plan.environmentPackageModules,
    hooks.plan.environmentPackageModules,
    "ENVIRONMENT",
  );
  const baseCli = record(baseline.manifests.cli),
    hookCli = record(hooks.manifests.cli);
  same(baseCli.sourceModules, hookCli.sourceModules, "SOURCE_MODULES");
  same(baseCli.assets, hookCli.assets, "ASSETS");
  if (baseCli.omission !== undefined || hookCli.omission !== undefined) {
    if (baseCli.omission === undefined || hookCli.omission === undefined)
      throw new Error("CLAUDE_VARIANTS_OMISSION_MISMATCH");
    const baseOmission = record(baseCli.omission),
      hookOmission = record(hookCli.omission);
    const corpus = record(baseOmission.corpus);
    if (
      corpus.binarySha256 !== baseline.plan.cli.binarySha256 ||
      !Array.isArray(corpus.provenance) ||
      corpus.provenance.length === 0
    )
      throw new Error("CLAUDE_VARIANTS_CORPUS_INVALID");
    same(baseOmission.corpus, hookOmission.corpus, "CORPUS_PROVENANCE");
    same(baseOmission.configuration, hookOmission.configuration, "CONFIGURATION");
  }
  return { catalog, baseline, hooks };
}

/** Keep candidates inspectable without publishing a pending or rejected graph to selectors. */
export async function writeClaudeReleaseVariantCatalog(
  input: Parameters<typeof validateClaudeReleaseVariantArtifacts>[0] & { readonly output: string },
) {
  const validated = await validateClaudeReleaseVariantArtifacts(input);
  // Qualification can inspect full graphs; publication still requires omission provenance.
  record(record(validated.baseline.manifests.cli).omission);
  record(record(validated.hooks.manifests.cli).omission);
  // Opening both graphs awaits I/O; a newer failure may have arrived during those reads.
  for (const { fullArtifact } of [validated.catalog.baseline, validated.catalog.hooks])
    if (input.ledger.getEligibility("claude-code", fullArtifact.releaseId).status !== "green")
      throw new Error("CLAUDE_VARIANTS_NOT_QUALIFIED");
  await NodeFSP.writeFile(input.output, encodeClaudeReleaseVariants(validated.catalog), {
    flag: "wx",
    mode: 0o600,
  });
  return validated.catalog;
}
