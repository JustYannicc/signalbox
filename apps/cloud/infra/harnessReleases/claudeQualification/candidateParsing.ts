import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { HarnessReleaseArtifactIdentity } from "../../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { HarnessReleaseArtifact } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import { readCandidateLedgerArtifactRows } from "./candidateLedger.ts";
import type {
  CandidateFilePin,
  ClaudePairCandidate,
  ClaudeReleaseLedgerCandidate,
} from "./contracts.ts";

export async function readClaudeQualificationCandidate(pairPath: string) {
  const resolvedPairPath = await NodeFSP.realpath(pairPath);
  const pairDirectory = NodePath.dirname(resolvedPairPath);
  const pair = decodePair(JSON.parse(await NodeFSP.readFile(resolvedPairPath, "utf8")) as unknown);
  const ledgerDirectory = await realDirectory(NodePath.join(pairDirectory, "ledger"));
  const descriptorBytes = await readPinnedFile(ledgerDirectory, pair.descriptor);
  const descriptor = decodeLedgerCandidate(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(descriptorBytes)) as unknown,
  );
  if (!samePin(pair.ledger, descriptor.files.ledger))
    throw new Error("CLAUDE_QUALIFICATION_LEDGER_PIN_MISMATCH");

  const expected = {
    baseline: descriptor.variants.baseline.artifact,
    hooks: descriptor.variants.hooks.artifact,
  };
  for (const variant of ["baseline", "hooks"] as const)
    if (!sameIdentity(pair.variants[variant], identityOf(expected[variant])))
      throw new Error(`CLAUDE_QUALIFICATION_${variant.toUpperCase()}_PAIR_IDENTITY_MISMATCH`);
  await readPinnedFile(ledgerDirectory, pair.ledger);
  const rows = await readCandidateLedgerArtifactRows({
    path: NodePath.join(ledgerDirectory, pair.ledger.path),
    scope: descriptor.scope,
    expected,
  });
  return { pair, pairDirectory, descriptor, rows };
}

async function readPinnedFile(directory: string, pin: CandidateFilePin) {
  const path = NodePath.join(directory, pin.path);
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error("CLAUDE_QUALIFICATION_PINNED_FILE_INVALID");
  const bytes = await NodeFSP.readFile(path);
  if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256)
    throw new Error("CLAUDE_QUALIFICATION_FILE_PIN_MISMATCH");
  return bytes;
}

async function realDirectory(path: string) {
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("CLAUDE_QUALIFICATION_INPUT_DIRECTORY_INVALID");
  return NodeFSP.realpath(path);
}

function decodePair(value: unknown): ClaudePairCandidate {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_PAIR_INVALID");
  if (
    raw.schema !== "signalbox/claude-release-pair-candidate/v1" ||
    raw.status !== "candidate" ||
    raw.qualification !== "pending"
  )
    throw new Error("CLAUDE_QUALIFICATION_PAIR_NOT_PENDING_CANDIDATE");
  const computer = asRecord(raw.trustedComputer, "CLAUDE_QUALIFICATION_PAIR_INVALID");
  const variants = asRecord(raw.variants, "CLAUDE_QUALIFICATION_PAIR_INVALID");
  const maxPreparedModuleBytes = raw.maxPreparedModuleBytes;
  if (!Number.isSafeInteger(maxPreparedModuleBytes) || (maxPreparedModuleBytes as number) <= 0)
    throw new Error("CLAUDE_QUALIFICATION_MODULE_ALLOWANCE_INVALID");
  return {
    schema: raw.schema,
    status: raw.status,
    qualification: raw.qualification,
    source: raw.source,
    trustedComputer: {
      sourceIdentity: requiredString(computer.sourceIdentity),
      manifestSha256: requiredString(computer.manifestSha256),
    },
    maxPreparedModuleBytes: maxPreparedModuleBytes as number,
    variants: {
      baseline: decodeIdentity(variants.baseline),
      hooks: decodeIdentity(variants.hooks),
    },
    ledger: decodePin(raw.ledger),
    descriptor: decodePin(raw.descriptor),
  };
}

function decodeLedgerCandidate(value: unknown): ClaudeReleaseLedgerCandidate {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_LEDGER_CANDIDATE_INVALID");
  if (
    raw.schema !== "signalbox/claude-release-ledger-candidate/v1" ||
    raw.status !== "candidate" ||
    raw.qualification !== "pending" ||
    (raw.scope !== "global" && raw.scope !== "project")
  )
    throw new Error("CLAUDE_QUALIFICATION_LEDGER_CANDIDATE_NOT_PENDING");
  const variants = asRecord(raw.variants, "CLAUDE_QUALIFICATION_LEDGER_CANDIDATE_INVALID");
  const eligibility = asRecord(raw.eligibility, "CLAUDE_QUALIFICATION_LEDGER_CANDIDATE_INVALID");
  const files = asRecord(raw.files, "CLAUDE_QUALIFICATION_LEDGER_CANDIDATE_INVALID");
  const baseline = decodeCandidateVariant(variants.baseline);
  const hooks = decodeCandidateVariant(variants.hooks);
  const baselineEligibility = decodePendingEligibility(eligibility.baseline);
  const hooksEligibility = decodePendingEligibility(eligibility.hooks);
  return {
    schema: raw.schema,
    status: raw.status,
    qualification: raw.qualification,
    scope: raw.scope,
    variants: { baseline, hooks },
    eligibility: { baseline: baselineEligibility, hooks: hooksEligibility },
    files: { ledger: decodePin(files.ledger) },
  };
}

function decodeCandidateVariant(value: unknown) {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_LEDGER_CANDIDATE_INVALID");
  return { artifact: decodeArtifact(raw.artifact) };
}

function decodePendingEligibility(value: unknown) {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_ELIGIBILITY_INVALID");
  if (raw.status !== "pending" || !Array.isArray(raw.reasons))
    throw new Error("CLAUDE_QUALIFICATION_ELIGIBILITY_NOT_PENDING");
  if (raw.reasons.some((reason) => typeof reason !== "string"))
    throw new Error("CLAUDE_QUALIFICATION_ELIGIBILITY_INVALID");
  return { status: "pending" as const, reasons: raw.reasons as string[] };
}

function decodeArtifact(value: unknown): HarnessReleaseArtifact {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_ARTIFACT_INVALID");
  if (raw.provider !== "claude-code") throw new Error("CLAUDE_QUALIFICATION_PROVIDER_MISMATCH");
  return {
    provider: "claude-code",
    releaseId: requiredString(raw.releaseId),
    artifactRef: requiredString(raw.artifactRef),
    artifactHash: requiredString(raw.artifactHash),
    sourceIdentity: requiredString(raw.sourceIdentity),
    fixtureIdentity: requiredString(raw.fixtureIdentity),
    createdAt: requiredString(raw.createdAt),
  };
}

function decodeIdentity(value: unknown): HarnessReleaseArtifactIdentity {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_ARTIFACT_IDENTITY_INVALID");
  return {
    artifactRef: requiredString(raw.artifactRef),
    artifactHash: requiredString(raw.artifactHash),
    sourceIdentity: requiredString(raw.sourceIdentity),
  };
}

function decodePin(value: unknown): CandidateFilePin {
  const raw = asRecord(value, "CLAUDE_QUALIFICATION_FILE_PIN_INVALID");
  const path = requiredString(raw.path);
  if (
    NodePath.isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => part === ".." || part === "") ||
    !Number.isSafeInteger(raw.bytes) ||
    (raw.bytes as number) < 0 ||
    !/^[a-f0-9]{64}$/u.test(requiredString(raw.sha256))
  )
    throw new Error("CLAUDE_QUALIFICATION_FILE_PIN_INVALID");
  return { path, bytes: raw.bytes as number, sha256: raw.sha256 as string };
}

function identityOf(artifact: HarnessReleaseArtifact): HarnessReleaseArtifactIdentity {
  return {
    artifactRef: artifact.artifactRef,
    artifactHash: artifact.artifactHash,
    sourceIdentity: artifact.sourceIdentity,
  };
}

function sameIdentity(left: HarnessReleaseArtifactIdentity, right: HarnessReleaseArtifactIdentity) {
  return (
    left.artifactRef === right.artifactRef &&
    left.artifactHash === right.artifactHash &&
    left.sourceIdentity === right.sourceIdentity
  );
}

function samePin(left: CandidateFilePin, right: CandidateFilePin) {
  return left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
}

function sha256(bytes: Uint8Array) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("CLAUDE_QUALIFICATION_STRING_REQUIRED");
  return value;
}
