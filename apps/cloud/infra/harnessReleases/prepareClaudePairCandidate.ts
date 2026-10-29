import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { runTrustedComputerManifestCli } from "./computerManifestCli.ts";
import { canonicalComputerJson, computerSha256 } from "./computerManifest/identity.ts";
import { captureCurrentSourceFreeze } from "./computerManifest/sourceFreeze.ts";
import { prepareHarnessArtifact } from "./prepareArtifact.ts";
import { resolveCandidateOutputDirectory, writeCandidateFile } from "./candidateOutput.ts";
import { writeClaudeReleaseLedgerCandidate } from "./writeClaudeReleaseLedgerCandidate.ts";

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
export async function prepareClaudePairCandidate(input: PrepareClaudePairCandidateInput) {
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
    Awaited<ReturnType<typeof prepareHarnessArtifact>>
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
    variants[variant] = await prepareHarnessArtifact({
      harness: "claude-code",
      sourceIdentity,
      computer: computer.trustedComputer,
      components: { cli, sdk: input.sdk },
      output: NodePath.join(outputDirectory, variant),
    });
  }
  const written = await writeClaudeReleaseLedgerCandidate({
    createdAt: input.createdAt,
    baseline: {
      directory: NodePath.join(outputDirectory, "baseline"),
      identity: variants.baseline,
    },
    hooks: { directory: NodePath.join(outputDirectory, "hooks"), identity: variants.hooks },
    trustedComputer: computer.trustedComputer,
    maxPreparedModuleBytes: input.maxPreparedModuleBytes,
    outputDirectory: NodePath.join(outputDirectory, "ledger"),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  const after = await captureCurrentSourceFreeze(repository);
  if (after.commit !== source.commit || after.sha256 !== source.sha256)
    throw new Error("CLAUDE_PAIR_SOURCE_CHANGED");
  const result = {
    schema: "signalbox/claude-release-pair-candidate/v1",
    status: "candidate",
    qualification: "pending",
    source,
    trustedComputer: computer.trustedComputer,
    maxPreparedModuleBytes: input.maxPreparedModuleBytes,
    variants,
    ledger: written.ledgerFile,
    descriptor: written.candidateFile,
    eligibility: written.descriptor.eligibility,
  } as const;
  await writeCandidateFile(
    NodePath.join(outputDirectory, "pair.json"),
    Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
  );
  return result;
}
