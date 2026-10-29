import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  openHarnessReleaseArtifact,
  type HarnessReleaseArtifactIdentity,
  type HarnessReleaseArtifactSource,
} from "../../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { HarnessReleaseArtifact } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type {
  HarnessCProductMachineService,
  HarnessCProductProgramService,
  HarnessCProductReleaseService,
} from "../../../src/harness/HarnessCProductCapabilities.ts";
import type { LoadHarnessReleaseOptions } from "../../../src/harness/HarnessReleaseLoader.ts";
import { loadHarnessRelease } from "../../../src/harness/HarnessReleaseLoader.ts";
import { artifactDirectorySource } from "../prepareArtifact.ts";
import { candidateProductReleaseVariants } from "./candidateVariants.ts";
import {
  derivePairedClaudeComponentVersions,
  type ClaudeComponentVersions,
} from "./candidateVersions.ts";
import { loadClaudeQualificationComputerInputs } from "./computerInputs.ts";
import { readClaudeQualificationCandidate } from "./candidateParsing.ts";
import {
  assertActualLoadedCandidateRelease,
  createCandidateServices,
  prepareVariant,
  type ClaudeQualificationPreparedVariant,
} from "./candidateServices.ts";
import type { ClaudeQualificationVariant } from "./contracts.ts";

export interface ClaudeQualificationPreparedInputs {
  readonly pair: Awaited<ReturnType<typeof readClaudeQualificationCandidate>>["pair"];
  readonly rows: Readonly<Record<ClaudeQualificationVariant, HarnessReleaseArtifact>>;
  readonly releaseVariants: ReturnType<typeof candidateProductReleaseVariants>["variants"];
  readonly variants: Readonly<
    Record<ClaudeQualificationVariant, ClaudeQualificationPreparedVariant>
  >;
  readonly componentVersions: ClaudeComponentVersions;
  readonly computer: Awaited<ReturnType<typeof loadClaudeQualificationComputerInputs>>;
  readonly createServices: (identity: { readonly uid: number; readonly gid: number }) => {
    readonly release: HarnessCProductReleaseService;
    readonly programs: HarnessCProductProgramService;
    readonly machine: HarnessCProductMachineService;
  };
}

/** Validate the actual pending pair for normal public ProductClaude consumption. */
export async function prepareClaudeQualificationInputs(input: {
  readonly pairPath: string;
  readonly programsDirectory: string;
  readonly machineInventoryPath: string;
}): Promise<ClaudeQualificationPreparedInputs> {
  const candidate = await readClaudeQualificationCandidate(input.pairPath);
  const pairStat = await NodeFSP.lstat(candidate.pairDirectory);
  if (pairStat.isSymbolicLink() || !pairStat.isDirectory())
    throw new Error("CLAUDE_QUALIFICATION_PAIR_DIRECTORY_INVALID");

  const releaseOptions = {} as Record<ClaudeQualificationVariant, LoadHarnessReleaseOptions>;
  const loaded = {} as Record<
    ClaudeQualificationVariant,
    Awaited<ReturnType<typeof loadHarnessRelease>>
  >;
  for (const variant of ["baseline", "hooks"] as const) {
    const directory = await realDirectory(NodePath.join(candidate.pairDirectory, variant));
    const source = artifactDirectorySource(directory) satisfies HarnessReleaseArtifactSource;
    const artifact = candidate.rows[variant];
    const identity = identityOf(artifact);
    await openHarnessReleaseArtifact(identity, source);
    const options: LoadHarnessReleaseOptions = {
      identity,
      source,
      trustedComputer: candidate.pair.trustedComputer,
      maxPreparedModuleBytes: candidate.pair.maxPreparedModuleBytes,
    };
    const verified = await loadHarnessRelease(options);
    if (verified.plan.harness !== "claude-code")
      throw new Error("CLAUDE_QUALIFICATION_PROVIDER_MISMATCH");
    releaseOptions[variant] = options;
    loaded[variant] = verified;
  }

  const componentVersions = derivePairedClaudeComponentVersions(
    loaded.baseline.plan,
    loaded.hooks.plan,
  );
  assertPairGraphs(loaded.baseline.plan, loaded.hooks.plan);
  const computer = await loadClaudeQualificationComputerInputs({
    computerManifestPath: NodePath.join(candidate.pairDirectory, "computer.json"),
    programsDirectory: input.programsDirectory,
    machineInventoryPath: input.machineInventoryPath,
    expectedTrustedComputer: candidate.pair.trustedComputer,
    expectedSource: candidate.pair.source,
  });
  const baseComputer = loaded.baseline.plan.computer;
  if (
    baseComputer.sourceIdentity !== computer.trustedComputer.sourceIdentity ||
    baseComputer.manifestSha256 !== computer.trustedComputer.manifestSha256
  )
    throw new Error("CLAUDE_QUALIFICATION_PRODUCT_COMPUTER_MISMATCH");

  const releaseVariants = candidateProductReleaseVariants(candidate.rows).variants;
  const variants = {
    baseline: prepareVariant(candidate.rows.baseline, releaseOptions.baseline, loaded.baseline),
    hooks: prepareVariant(candidate.rows.hooks, releaseOptions.hooks, loaded.hooks),
  };
  const createServices = (identity: { readonly uid: number; readonly gid: number }) =>
    createCandidateServices({
      pairDirectory: candidate.pairDirectory,
      rows: candidate.rows,
      pair: candidate.pair,
      computer,
      identity,
    });
  return {
    pair: candidate.pair,
    rows: candidate.rows,
    releaseVariants,
    variants,
    componentVersions,
    computer,
    createServices,
  };
}

export { assertActualLoadedCandidateRelease };

function assertPairGraphs(
  baseline: Awaited<ReturnType<typeof loadHarnessRelease>>["plan"],
  hooks: Awaited<ReturnType<typeof loadHarnessRelease>>["plan"],
) {
  if (
    baseline.harness !== "claude-code" ||
    hooks.harness !== "claude-code" ||
    !same(baseline.cli, hooks.cli) ||
    !same(baseline.sdk, hooks.sdk) ||
    !same(baseline.computer, hooks.computer) ||
    !same(baseline.environmentPackageModules, hooks.environmentPackageModules) ||
    Object.keys(baseline.workerEntries).length !== 0 ||
    Object.keys(hooks.workerEntries).length !== 1 ||
    hooks.workerEntries["hooks-worker"] === undefined
  )
    throw new Error("CLAUDE_QUALIFICATION_PAIR_GRAPH_MISMATCH");
}

async function realDirectory(path: string) {
  const stat = await NodeFSP.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("CLAUDE_QUALIFICATION_INPUT_DIRECTORY_INVALID");
  return NodeFSP.realpath(path);
}

function identityOf(artifact: HarnessReleaseArtifact): HarnessReleaseArtifactIdentity {
  return {
    artifactRef: artifact.artifactRef,
    artifactHash: artifact.artifactHash,
    sourceIdentity: artifact.sourceIdentity,
  };
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("CLAUDE_QUALIFICATION_INPUT_INVALID");
  return encoded;
}
