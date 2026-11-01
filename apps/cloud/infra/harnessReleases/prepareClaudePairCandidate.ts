import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { runTrustedComputerManifestCli } from "./computerManifestCli.ts";
import { canonicalComputerJson, computerSha256 } from "./computerManifest/identity.ts";
import { captureCurrentSourceFreeze } from "./computerManifest/sourceFreeze.ts";
import { buildHarnessQualificationArtifact } from "./prepareArtifact.ts";
import { inspectQualificationArtifact } from "./inspectQualificationArtifact.ts";
import { candidateFilePin } from "./candidateOutput.ts";
import { readClaudePairBuild } from "./claudePairBuild.ts";
import type { HarnessReleaseBuiltinFindings } from "../../src/harnessReleases/HarnessReleaseBuiltinFindings.ts";
import { resolveCandidateOutputDirectory, writeCandidateFile } from "./candidateOutput.ts";
import { writeClaudeReleaseLedgerCandidate } from "./writeClaudeReleaseLedgerCandidate.ts";
import { directoryHarnessArtifactStore, publishHarnessArtifact } from "./publishArtifact.ts";
import { writeReleaseDeploymentAssets } from "./deploymentAssets.ts";

export interface PrepareClaudePairCandidateInput {
  readonly createdAt: string;
  readonly baselineCli: string;
  readonly hooksCli: string;
  readonly sdk: string;
  readonly programs: string;
  readonly machineInventory: string;
  readonly maxPreparedModuleBytes: number;
  readonly output: string;
  readonly projectId?: string;
}

/** Assemble normal producer outputs while every runtime qualification gate remains pending. */
export async function buildClaudePairCandidate(input: PrepareClaudePairCandidateInput) {
  const repository = NodePath.resolve(import.meta.dirname, "../../../..");
  const { outputDirectory } = await resolveCandidateOutputDirectory(input.output);
  const relative = NodePath.relative(await NodeFSP.realpath(repository), outputDirectory);
  if (
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  )
    throw new Error("CLAUDE_PAIR_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  if (!Number.isSafeInteger(input.maxPreparedModuleBytes) || input.maxPreparedModuleBytes <= 0)
    throw new Error("CLAUDE_PAIR_MODULE_ALLOWANCE_INVALID");
  await NodeFSP.mkdir(outputDirectory);

  const computer = await runTrustedComputerManifestCli([
    "--programs",
    input.programs,
    "--machine-inventory",
    input.machineInventory,
    "--result",
    NodePath.join(outputDirectory, "computer.json"),
  ]);
  const source = computer.manifest.identityInputs.source;
  const sdkManifest = await NodeFSP.readFile(NodePath.join(input.sdk, "manifest.json"));
  const variants = {} as Record<
    "baseline" | "hooks",
    Awaited<ReturnType<typeof buildHarnessQualificationArtifact>>["identity"]
  >;
  for (const variant of ["baseline", "hooks"] as const) {
    const cli = variant === "baseline" ? input.baselineCli : input.hooksCli;
    const cliManifest = await NodeFSP.readFile(NodePath.join(cli, "manifest.json"));
    const sourceIdentity = computerSha256(
      canonicalComputerJson({
        format: "signalbox-claude-pair-source-v1",
        variant,
        source,
        trustedComputer: computer.trustedComputer,
        cliManifestSha256: computerSha256(cliManifest),
        sdkManifestSha256: computerSha256(sdkManifest),
      }),
    );
    const prepared = await buildHarnessQualificationArtifact({
      harness: "claude-code",
      sourceIdentity,
      computer: computer.trustedComputer,
      components: { cli, sdk: input.sdk },
      output: NodePath.join(outputDirectory, variant),
    });
    variants[variant] = prepared.identity;
  }
  const build = {
    schema: "signalbox/claude-pair-build/v1" as const,
    status: "builtin-inventory-pending" as const,
    createdAt: input.createdAt,
    sourceCommit: source.commit,
    sourceSha256: source.sha256,
    trustedComputer: computer.trustedComputer,
    maxPreparedModuleBytes: input.maxPreparedModuleBytes,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    variants,
  };
  const after = await captureCurrentSourceFreeze(repository);
  if (after.commit !== source.commit || after.sha256 !== source.sha256)
    throw new Error("CLAUDE_PAIR_SOURCE_CHANGED");
  const bytes = Buffer.from(`${JSON.stringify(build, null, 2)}\n`);
  await writeCandidateFile(NodePath.join(outputDirectory, "pair-build.json"), bytes);
  return { ...build, outputDirectory, build: candidateFilePin("pair-build.json", bytes) };
}

export async function completeClaudePairCandidate(
  directory: string,
  buildSha256: string,
  inventories?: { readonly baseline: string; readonly hooks: string },
) {
  const outputDirectory = await NodeFSP.realpath(directory);
  const build = await readClaudePairBuild(outputDirectory, buildSha256);
  const repository = NodePath.resolve(import.meta.dirname, "../../../..");
  const source = await captureCurrentSourceFreeze(repository);
  if (source.commit !== build.sourceCommit || source.sha256 !== build.sourceSha256)
    throw new Error("CLAUDE_PAIR_SOURCE_CHANGED");
  const { variants } = build;
  const openFindings = {} as Record<"baseline" | "hooks", HarnessReleaseBuiltinFindings>;
  for (const variant of ["baseline", "hooks"] as const) {
    const inspected = await inspectQualificationArtifact({
      directory: NodePath.join(outputDirectory, variant),
      identity: variants[variant],
      ...(inventories === undefined ? {} : { inventory: inventories[variant] }),
    });
    openFindings[variant] = inspected.openFindings;
  }
  await readClaudePairBuild(outputDirectory, buildSha256);
  const written = await writeClaudeReleaseLedgerCandidate({
    createdAt: build.createdAt,
    baseline: {
      directory: NodePath.join(outputDirectory, "baseline"),
      identity: variants.baseline,
    },
    hooks: { directory: NodePath.join(outputDirectory, "hooks"), identity: variants.hooks },
    trustedComputer: build.trustedComputer,
    maxPreparedModuleBytes: build.maxPreparedModuleBytes,
    outputDirectory: NodePath.join(outputDirectory, "ledger"),
    ...(build.projectId === undefined ? {} : { projectId: build.projectId }),
  });
  const projectId = build.projectId ?? "signalbox";
  const assetsDirectory = NodePath.join(outputDirectory, "deployment-assets");
  const store = directoryHarnessArtifactStore(assetsDirectory);
  const assets = [];
  for (const variant of ["baseline", "hooks"] as const) {
    const published = await publishHarnessArtifact(
      variants[variant],
      NodePath.join(outputDirectory, variant),
      { projectId, store },
    );
    assets.push(published.assetIndex);
  }
  const records = written.descriptor.variants;
  const deploymentAssets = await writeReleaseDeploymentAssets({
    directory: assetsDirectory,
    deployment: {
      schemaVersion: 1,
      purpose: "qualification",
      releasable: false,
      projectId,
      claudeVariants: {
        baseline: { variant: "baseline", fullArtifact: records.baseline.artifact },
        hooks: { variant: "hooks", fullArtifact: records.hooks.artifact },
      },
      // The candidate writer verifies an empty proof ledger before returning these records.
      ledger: (["baseline", "hooks"] as const).map((variant) => ({
        artifact: records[variant].artifact,
        proofs: [],
        openFindings: [openFindings[variant]],
      })),
      assets,
    },
  });
  const after = await captureCurrentSourceFreeze(repository);
  if (after.commit !== source.commit || after.sha256 !== source.sha256)
    throw new Error("CLAUDE_PAIR_SOURCE_CHANGED");
  const result = {
    schema: "signalbox/claude-release-pair-candidate/v1",
    status: "candidate",
    qualification: "pending",
    releasable: false,
    source,
    trustedComputer: build.trustedComputer,
    maxPreparedModuleBytes: build.maxPreparedModuleBytes,
    variants,
    ledger: written.ledgerFile,
    descriptor: written.candidateFile,
    eligibility: written.descriptor.eligibility,
    deploymentAssets,
  } as const;
  await writeCandidateFile(
    NodePath.join(outputDirectory, "pair.json"),
    Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
  );
  return result;
}

export async function prepareClaudePairCandidate(input: PrepareClaudePairCandidateInput) {
  const built = await buildClaudePairCandidate(input);
  return completeClaudePairCandidate(built.outputDirectory, built.build.sha256);
}
