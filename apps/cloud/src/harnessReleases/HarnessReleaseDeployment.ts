import * as Schema from "effect/Schema";
import { readPinnedAsset, type AssetFetcher } from "../assets/ChunkedAsset.ts";
import { resolveClaudeReleaseVariants } from "./ClaudeReleaseVariants.ts";
import {
  HarnessReleaseAssetIndex,
  createHarnessArtifactAssetSource,
} from "./HarnessReleaseAssetSource.ts";
import type { HarnessReleaseArtifactSource } from "./HarnessReleaseArtifact.ts";
import type {
  HarnessReleaseLedger,
  HarnessReleaseArtifact,
  HarnessReleaseProof,
} from "./HarnessReleaseLedger.ts";
import { normalizeArtifact, normalizeProof, releaseEligibility } from "./internal/records.ts";
import { HarnessReleaseBuiltinFindings } from "./HarnessReleaseBuiltinFindings.ts";

const Artifact = Schema.Struct({
  provider: Schema.Literals(["claude-code", "agent-sdk", "codex"]),
  releaseId: Schema.String,
  artifactRef: Schema.String,
  artifactHash: Schema.String,
  sourceIdentity: Schema.String,
  fixtureIdentity: Schema.String,
  createdAt: Schema.String,
});
const Entry = Schema.Struct({
  artifact: Artifact,
  proofs: Schema.Array(Schema.Unknown),
  openFindings: Schema.optionalKey(Schema.Array(HarnessReleaseBuiltinFindings)),
});
export const HarnessReleaseDeployment = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  purpose: Schema.Literals(["release", "qualification"]),
  releasable: Schema.optionalKey(Schema.Boolean),
  projectId: Schema.String,
  ledger: Schema.Array(Entry),
  assets: Schema.Array(HarnessReleaseAssetIndex),
  claudeVariants: Schema.optionalKey(Schema.Unknown),
});
export type HarnessReleaseDeployment = typeof HarnessReleaseDeployment.Type;
const decode = Schema.decodeUnknownSync(HarnessReleaseDeployment, {
  onExcessProperty: "error",
  reportInput: false,
});

export function snapshotDeploymentLedger(
  ledger: Pick<HarnessReleaseLedger, "getArtifact" | "listProofs" | "getEligibility">,
  artifacts: readonly HarnessReleaseArtifact[],
) {
  return artifacts.map((artifact) => {
    const stored = ledger.getArtifact(artifact.provider, artifact.releaseId);
    if (
      !stored ||
      Object.entries(artifact).some(([field, value]) => Reflect.get(stored, field) !== value)
    )
      throw new Error("HARNESS_DEPLOYMENT_LEDGER_MISMATCH");
    if (ledger.getEligibility(artifact.provider, artifact.releaseId).status !== "green")
      throw new Error("HARNESS_DEPLOYMENT_NOT_QUALIFIED");
    return { artifact: stored, proofs: ledger.listProofs(artifact.provider, artifact.releaseId) };
  });
}

const openDeployment = (
  input: unknown,
  binding: AssetFetcher,
  projectId: string,
  purpose: "release" | "qualification",
) => {
  const deployment = decode(structuredClone(input));
  if (deployment.purpose !== purpose) throw new Error("HARNESS_DEPLOYMENT_PURPOSE_MISMATCH");
  if (deployment.releasable !== undefined && deployment.releasable !== (purpose === "release"))
    throw new Error("HARNESS_DEPLOYMENT_NOT_RELEASABLE");
  if (!projectId.trim() || deployment.projectId !== projectId)
    throw new Error("HARNESS_DEPLOYMENT_PROJECT_MISMATCH");
  const records = new Map<
    string,
    {
      artifact: HarnessReleaseArtifact;
      proofs: readonly HarnessReleaseProof[];
      openFindings: readonly HarnessReleaseBuiltinFindings[];
    }
  >();
  const byReference = new Map<string, HarnessReleaseArtifact>();
  const proofIds = new Set<string>();
  const key = (provider: string, releaseId: string) => JSON.stringify([provider, releaseId]);
  for (const entry of deployment.ledger) {
    const openFindings = entry.openFindings ?? [];
    if (purpose === "release" && openFindings.length > 0)
      throw new Error("HARNESS_DEPLOYMENT_OPEN_FINDINGS");
    const artifact = normalizeArtifact(entry.artifact);
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.artifactHash) ||
      !/^[a-f0-9]{64}$/u.test(artifact.sourceIdentity) ||
      artifact.artifactRef !== `sha256:${artifact.artifactHash}` ||
      records.has(key(artifact.provider, artifact.releaseId)) ||
      byReference.has(artifact.artifactRef)
    )
      throw new Error("HARNESS_DEPLOYMENT_ARTIFACT_INVALID");
    const proofs = entry.proofs.map((input) => {
      const proof = normalizeProof(input);
      if (
        proofIds.has(proof.proofId) ||
        proof.provider !== artifact.provider ||
        proof.releaseId !== artifact.releaseId ||
        proof.artifactHash !== artifact.artifactHash ||
        proof.sourceIdentity !== artifact.sourceIdentity ||
        proof.fixtureIdentity !== artifact.fixtureIdentity
      )
        throw new Error("HARNESS_DEPLOYMENT_PROOF_MISMATCH");
      proofIds.add(proof.proofId);
      return proof;
    });
    if (purpose === "release" && releaseEligibility(proofs).status !== "green")
      throw new Error("HARNESS_DEPLOYMENT_NOT_QUALIFIED");
    records.set(key(artifact.provider, artifact.releaseId), { artifact, proofs, openFindings });
    byReference.set(artifact.artifactRef, artifact);
  }
  const sources = new Map<string, HarnessReleaseArtifactSource>();
  for (const index of deployment.assets) {
    if (
      byReference.get(index.artifactRef)?.sourceIdentity !== index.sourceIdentity ||
      sources.has(index.artifactRef)
    )
      throw new Error("HARNESS_DEPLOYMENT_ASSET_MISMATCH");
    sources.set(index.artifactRef, createHarnessArtifactAssetSource(binding, projectId, index));
  }
  if (sources.size === 0 || sources.size !== records.size)
    throw new Error("HARNESS_DEPLOYMENT_ASSET_MISSING");
  const ledger: Pick<HarnessReleaseLedger, "getArtifact" | "getEligibility" | "listProofs"> & {
    getOpenFindings: (
      provider: string,
      releaseId: string,
    ) => readonly HarnessReleaseBuiltinFindings[];
  } = {
    getOpenFindings: (provider, releaseId) =>
      structuredClone(records.get(key(provider, releaseId))?.openFindings ?? []),
    getArtifact: (provider, releaseId) =>
      structuredClone(records.get(key(provider, releaseId))?.artifact ?? null),
    getEligibility: (provider, releaseId) => {
      const entry = records.get(key(provider, releaseId));
      if (!entry) throw new Error("HARNESS_DEPLOYMENT_ARTIFACT_MISSING");
      return releaseEligibility(entry.proofs);
    },
    listProofs: (provider, releaseId) =>
      structuredClone(records.get(key(provider, releaseId))?.proofs ?? []),
  };
  const claudeVariants =
    deployment.claudeVariants === undefined
      ? undefined
      : resolveClaudeReleaseVariants(deployment.claudeVariants, ledger);
  const selected = (reference: string) => {
    const source = sources.get(reference);
    if (!source) throw new Error("HARNESS_DEPLOYMENT_ARTIFACT_MISSING");
    return source;
  };
  const source: HarnessReleaseArtifactSource = {
    read: async (reference, path) => selected(reference).read(reference, path),
    readRange: async (reference, path, offset, length) =>
      selected(reference).readRange!(reference, path, offset, length),
  };
  return { ledger, source, claudeVariants, releasable: purpose === "release" };
};

/** Only qualified releases enter the normal selector. Records live in this deployment. */
export const openHarnessReleaseDeployment = (
  input: unknown,
  binding: AssetFetcher,
  projectId: string,
) => openDeployment(input, binding, projectId, "release");

/** Qualification consumes candidates through the same hash-checked product loader. */
export const openHarnessReleaseQualificationInputs = (
  input: unknown,
  binding: AssetFetcher,
  projectId: string,
) => openDeployment(input, binding, projectId, "qualification");

export async function readHarnessReleaseDeployment(
  binding: AssetFetcher,
  pin: { readonly path: string; readonly bytes: number; readonly sha256: string },
  projectId: string,
) {
  const bytes = await readPinnedAsset(binding, pin);
  return openHarnessReleaseDeployment(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    binding,
    projectId,
  );
}

export async function readHarnessReleaseQualificationInputs(
  binding: AssetFetcher,
  pin: { readonly path: string; readonly bytes: number; readonly sha256: string },
  projectId: string,
) {
  const bytes = await readPinnedAsset(binding, pin);
  return openHarnessReleaseQualificationInputs(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    binding,
    projectId,
  );
}
