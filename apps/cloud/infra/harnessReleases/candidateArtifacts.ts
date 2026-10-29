import {
  type HarnessReleaseArtifactIdentity,
  type HarnessReleaseArtifactSource,
  openHarnessReleaseArtifact,
} from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { HarnessReleaseArtifact } from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import { loadHarnessRelease } from "../../src/harness/HarnessReleaseLoader.ts";
import type { ClaudeReleasePlan } from "../../src/harness/HarnessReleasePlan.ts";
import { candidateSha256 } from "./candidateOutput.ts";
import { artifactDirectorySource } from "./prepareArtifact.ts";

export type ClaudePlan = Extract<ClaudeReleasePlan, { readonly harness: "claude-code" }>;

export interface CandidatePreparedDirectory {
  readonly directory: string;
  readonly identity: HarnessReleaseArtifactIdentity;
}

export interface LoadedClaudeCandidateVariant {
  readonly plan: ClaudePlan;
  readonly manifestPaths: { readonly cli: string; readonly sdk: string };
  readonly manifests: {
    readonly artifactManifest: Uint8Array;
    readonly cliManifest: Uint8Array;
    readonly sdkManifest: Uint8Array;
  };
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("HARNESS_CANDIDATE_IDENTITY_INVALID");
  return json;
};

/** Opens the actual prepared graph and verifies every module through the normal loader. */
export const loadClaudeCandidateVariant = async (
  input: CandidatePreparedDirectory,
  trustedComputer: { readonly sourceIdentity: string; readonly manifestSha256: string },
  maxPreparedModuleBytes: number,
): Promise<LoadedClaudeCandidateVariant> => {
  const source = artifactDirectorySource(input.directory) satisfies HarnessReleaseArtifactSource;
  const opened = await openHarnessReleaseArtifact(input.identity, source);
  const loaded = await loadHarnessRelease({
    identity: input.identity,
    source,
    trustedComputer,
    maxPreparedModuleBytes,
  });
  if (loaded.plan.harness !== "claude-code") throw new Error("HARNESS_CANDIDATE_PROVIDER_MISMATCH");

  const cliPath = opened.manifest.components.cli?.manifest;
  const sdkPath = opened.manifest.components.sdk?.manifest;
  if (!cliPath || !sdkPath) throw new Error("HARNESS_CANDIDATE_COMPONENT_MANIFEST_MISSING");
  const [artifactManifest, cliManifest, sdkManifest] = await Promise.all([
    source.read(input.identity.artifactRef, "manifest.json"),
    opened.read(cliPath),
    opened.read(sdkPath),
  ]);
  if (candidateSha256(artifactManifest) !== input.identity.artifactHash)
    throw new Error("HARNESS_CANDIDATE_ARTIFACT_MANIFEST_MISMATCH");

  return {
    plan: loaded.plan,
    manifestPaths: { cli: cliPath, sdk: sdkPath },
    manifests: { artifactManifest, cliManifest, sdkManifest },
  };
};

const canonicalReleaseIdentity = (plan: ClaudePlan) => ({ cli: plan.cli, sdk: plan.sdk });

export function assertClaudeCandidatePair(
  baseline: LoadedClaudeCandidateVariant,
  hooks: LoadedClaudeCandidateVariant,
) {
  if (Object.keys(baseline.plan.workerEntries).length !== 0)
    throw new Error("HARNESS_CANDIDATE_BASELINE_WORKER_ENTRIES");
  const entries = Object.keys(hooks.plan.workerEntries);
  if (entries.length !== 1 || entries[0] !== "hooks-worker")
    throw new Error("HARNESS_CANDIDATE_HOOKS_WORKER_ENTRIES");
  for (const [name, left, right] of [
    ["OFFICIAL_CLI", baseline.plan.cli, hooks.plan.cli],
    ["SDK", baseline.plan.sdk, hooks.plan.sdk],
    ["COMPUTER", baseline.plan.computer, hooks.plan.computer],
    ["ENVIRONMENT", baseline.plan.environmentPackageModules, hooks.plan.environmentPackageModules],
  ] as const)
    if (canonicalJson(left) !== canonicalJson(right))
      throw new Error(`HARNESS_CANDIDATE_${name}_MISMATCH`);
  if (
    candidateSha256(baseline.manifests.sdkManifest) !== candidateSha256(hooks.manifests.sdkManifest)
  )
    throw new Error("HARNESS_CANDIDATE_SDK_GRAPH_MISMATCH");
  const preparedBytes = (variant: LoadedClaudeCandidateVariant) =>
    Object.values(variant.plan.preparedModules).reduce((total, module) => total + module.bytes, 0);
  if (preparedBytes(hooks) - preparedBytes(baseline) > 524288)
    throw new Error("HARNESS_CANDIDATE_HOOKS_STARTUP_BYTES_EXCEEDED");
}

/** Identities come from validated provider release declarations and the prepared artifact hash. */
export const candidateReleaseArtifact = (
  identity: HarnessReleaseArtifactIdentity,
  plan: ClaudePlan,
  createdAt: string,
): HarnessReleaseArtifact => ({
  provider: "claude-code",
  releaseId: `claude-code:${plan.cli.version}:agent-sdk:${plan.sdk.version}:${identity.artifactHash}`,
  artifactHash: identity.artifactHash,
  artifactRef: identity.artifactRef,
  sourceIdentity: identity.sourceIdentity,
  fixtureIdentity: candidateSha256(
    new TextEncoder().encode(canonicalJson(canonicalReleaseIdentity(plan))),
  ),
  createdAt,
});
