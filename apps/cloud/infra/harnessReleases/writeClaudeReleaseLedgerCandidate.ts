import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  HarnessReleaseArtifact,
  HarnessReleaseEligibility,
} from "../../src/harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessReleaseArtifactIdentity } from "../../src/harnessReleases/HarnessReleaseArtifact.ts";
import {
  assertStandaloneCandidateSqlite,
  candidateFilePin,
  publishCandidateDirectory,
  resolveCandidateOutputDirectory,
  verifyCandidateFilePin,
  writeCandidateFile,
  type ClaudeReleaseCandidateFilePin,
} from "./candidateOutput.ts";
import {
  verifyCandidateLedgerSnapshot,
  writeCandidateLedgerSnapshot,
} from "./candidateLedgerSnapshot.ts";
import {
  assertClaudeCandidatePair,
  candidateReleaseArtifact,
  loadClaudeCandidateVariant,
  type ClaudePlan,
} from "./candidateArtifacts.ts";

export type { ClaudeReleaseCandidateFilePin } from "./candidateOutput.ts";

export interface ClaudeReleaseCandidateInput {
  readonly createdAt: string;
  readonly baseline: {
    readonly directory: string;
    readonly identity: HarnessReleaseArtifactIdentity;
  };
  readonly hooks: {
    readonly directory: string;
    readonly identity: HarnessReleaseArtifactIdentity;
  };
  readonly trustedComputer: {
    readonly sourceIdentity: string;
    readonly manifestSha256: string;
  };
  readonly maxPreparedModuleBytes: number;
  readonly projectId?: string;
  /** A new directory containing the ledger snapshot and candidate descriptor. */
  readonly outputDirectory: string;
}

type ComponentPins = {
  readonly artifactManifest: ClaudeReleaseCandidateFilePin;
  readonly cliManifest: ClaudeReleaseCandidateFilePin;
  readonly sdkManifest: ClaudeReleaseCandidateFilePin;
};
type CandidateVariant = {
  readonly artifact: HarnessReleaseArtifact;
  readonly official: { readonly cli: ClaudePlan["cli"]; readonly sdk: ClaudePlan["sdk"] };
  readonly verifiedCandidateGraph: {
    readonly preparedModules: ClaudePlan["preparedModules"];
    readonly assets: ClaudePlan["assets"];
    readonly moduleMaps: ClaudePlan["moduleMaps"];
    readonly workerEntryIds: ReadonlyArray<string>;
  };
  readonly pins: ComponentPins;
};

export interface ClaudeReleaseLedgerCandidateDescriptor {
  readonly schema: "signalbox/claude-release-ledger-candidate/v1";
  readonly status: "candidate";
  readonly qualification: "pending";
  readonly scope: "global" | "project";
  readonly variants: {
    readonly baseline: CandidateVariant;
    readonly hooks: CandidateVariant;
  };
  readonly eligibility: {
    readonly baseline: HarnessReleaseEligibility;
    readonly hooks: HarnessReleaseEligibility;
  };
  readonly files: {
    readonly ledger: ClaudeReleaseCandidateFilePin;
    readonly baseline: ComponentPins;
    readonly hooks: ComponentPins;
  };
}

export interface WrittenClaudeReleaseLedgerCandidate {
  readonly descriptor: ClaudeReleaseLedgerCandidateDescriptor;
  readonly candidateFile: ClaudeReleaseCandidateFilePin;
  readonly ledgerFile: ClaudeReleaseCandidateFilePin;
}

const isWithin = (root: string, candidate: string) => {
  if (root === candidate) return true;
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};

const pathsOverlap = (left: string, right: string) =>
  isWithin(left, right) || isWithin(right, left);

const makeManifestPins = (
  manifestPaths: { readonly cli: string; readonly sdk: string },
  manifests: {
    readonly artifactManifest: Uint8Array;
    readonly cliManifest: Uint8Array;
    readonly sdkManifest: Uint8Array;
  },
): ComponentPins => ({
  artifactManifest: candidateFilePin("manifest.json", manifests.artifactManifest),
  cliManifest: candidateFilePin(manifestPaths.cli, manifests.cliManifest),
  sdkManifest: candidateFilePin(manifestPaths.sdk, manifests.sdkManifest),
});

/** Writes a candidate-only ledger snapshot. It never creates or promotes qualification proof. */
export async function writeClaudeReleaseLedgerCandidate(
  input: ClaudeReleaseCandidateInput,
): Promise<WrittenClaudeReleaseLedgerCandidate> {
  if (!Number.isSafeInteger(input.maxPreparedModuleBytes) || input.maxPreparedModuleBytes <= 0)
    throw new Error("HARNESS_CANDIDATE_MODULE_ALLOWANCE_INVALID");
  if (input.projectId !== undefined && input.projectId.trim() === "")
    throw new Error("HARNESS_CANDIDATE_PROJECT_ID_INVALID");

  const { outputParent, outputDirectory } = await resolveCandidateOutputDirectory(
    input.outputDirectory,
  );

  const [baselineDirectory, hooksDirectory] = await Promise.all([
    NodeFSP.realpath(input.baseline.directory),
    NodeFSP.realpath(input.hooks.directory),
  ]);
  if (
    pathsOverlap(outputDirectory, baselineDirectory) ||
    pathsOverlap(outputDirectory, hooksDirectory) ||
    pathsOverlap(baselineDirectory, hooksDirectory)
  )
    throw new Error("HARNESS_CANDIDATE_DIRECTORIES_OVERLAP");

  const baselineVerified = await loadClaudeCandidateVariant(
    { ...input.baseline, directory: baselineDirectory },
    input.trustedComputer,
    input.maxPreparedModuleBytes,
  );
  const hooksVerified = await loadClaudeCandidateVariant(
    { ...input.hooks, directory: hooksDirectory },
    input.trustedComputer,
    input.maxPreparedModuleBytes,
  );
  const createdAt = input.createdAt;
  const baseline = {
    ...baselineVerified,
    artifact: candidateReleaseArtifact(input.baseline.identity, baselineVerified.plan, createdAt),
  };
  const hooks = {
    ...hooksVerified,
    artifact: candidateReleaseArtifact(input.hooks.identity, hooksVerified.plan, createdAt),
  };
  if (
    baseline.artifact.artifactHash === hooks.artifact.artifactHash ||
    baseline.artifact.releaseId === hooks.artifact.releaseId
  )
    throw new Error("HARNESS_CANDIDATE_VARIANTS_NOT_DISTINCT");
  assertClaudeCandidatePair(baseline, hooks);

  const stageDirectory = await NodeFSP.mkdtemp(
    NodePath.join(outputParent, ".harness-release-candidate-"),
  );
  const ledgerPath = NodePath.join(stageDirectory, "ledger.sqlite");
  try {
    const expectedArtifacts = [baseline.artifact, hooks.artifact] as const;
    writeCandidateLedgerSnapshot(ledgerPath, input.projectId, expectedArtifacts);
    await assertStandaloneCandidateSqlite(ledgerPath);

    const baselinePins = makeManifestPins(baseline.manifestPaths, baseline.manifests);
    const hooksPins = makeManifestPins(hooks.manifestPaths, hooks.manifests);
    const ledgerBytes = await NodeFSP.readFile(ledgerPath);
    const ledgerPin = candidateFilePin("ledger.sqlite", ledgerBytes);
    const eligibility = verifyCandidateLedgerSnapshot(
      ledgerPath,
      input.projectId,
      expectedArtifacts,
    );
    const descriptor: ClaudeReleaseLedgerCandidateDescriptor = {
      schema: "signalbox/claude-release-ledger-candidate/v1",
      status: "candidate",
      qualification: "pending",
      scope: input.projectId === undefined ? "global" : "project",
      variants: {
        baseline: {
          artifact: baseline.artifact,
          official: { cli: baseline.plan.cli, sdk: baseline.plan.sdk },
          verifiedCandidateGraph: {
            preparedModules: baseline.plan.preparedModules,
            assets: baseline.plan.assets,
            moduleMaps: baseline.plan.moduleMaps,
            workerEntryIds: Object.keys(baseline.plan.workerEntries).sort(),
          },
          pins: baselinePins,
        },
        hooks: {
          artifact: hooks.artifact,
          official: { cli: hooks.plan.cli, sdk: hooks.plan.sdk },
          verifiedCandidateGraph: {
            preparedModules: hooks.plan.preparedModules,
            assets: hooks.plan.assets,
            moduleMaps: hooks.plan.moduleMaps,
            workerEntryIds: Object.keys(hooks.plan.workerEntries).sort(),
          },
          pins: hooksPins,
        },
      },
      eligibility: { baseline: eligibility[0]!, hooks: eligibility[1]! },
      files: { ledger: ledgerPin, baseline: baselinePins, hooks: hooksPins },
    };
    const candidateBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    await writeCandidateFile(NodePath.join(stageDirectory, "candidate.json"), candidateBytes);
    const candidatePin = candidateFilePin("candidate.json", candidateBytes);

    for (const pin of [ledgerPin, candidatePin]) await verifyCandidateFilePin(stageDirectory, pin);
    for (const pin of Object.values(baselinePins))
      await verifyCandidateFilePin(baselineDirectory, pin);
    for (const pin of Object.values(hooksPins)) await verifyCandidateFilePin(hooksDirectory, pin);
    verifyCandidateLedgerSnapshot(ledgerPath, input.projectId, expectedArtifacts);
    await assertStandaloneCandidateSqlite(ledgerPath);

    await publishCandidateDirectory(stageDirectory, outputDirectory, async () => {
      for (const pin of [ledgerPin, candidatePin])
        await verifyCandidateFilePin(outputDirectory, pin);
      for (const pin of Object.values(baselinePins))
        await verifyCandidateFilePin(baselineDirectory, pin);
      for (const pin of Object.values(hooksPins)) await verifyCandidateFilePin(hooksDirectory, pin);
      const reopenedEligibility = verifyCandidateLedgerSnapshot(
        NodePath.join(outputDirectory, ledgerPin.path),
        input.projectId,
        expectedArtifacts,
      );
      if (JSON.stringify(reopenedEligibility) !== JSON.stringify(eligibility))
        throw new Error("HARNESS_CANDIDATE_ELIGIBILITY_CHANGED");
      await assertStandaloneCandidateSqlite(NodePath.join(outputDirectory, ledgerPin.path));
    });

    return { descriptor, candidateFile: candidatePin, ledgerFile: ledgerPin };
  } finally {
    await NodeFSP.rm(stageDirectory, { recursive: true, force: true });
  }
}
