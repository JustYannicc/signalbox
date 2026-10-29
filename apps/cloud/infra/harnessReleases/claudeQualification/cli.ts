import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { prepareClaudeQualificationInputs } from "./candidate.ts";
import { RELEASE_CRITERIA } from "./criteria.ts";
import type { ClaudeQualificationPreparedVariant } from "./candidateServices.ts";

export async function runClaudeQualificationCli(args: readonly string[]) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      pair: { type: "string" },
      programs: { type: "string" },
      "machine-inventory": { type: "string" },
      output: { type: "string" },
    },
  });
  const pairPath = required(values.pair, "--pair");
  const programsDirectory = required(values.programs, "--programs");
  const machineInventoryPath = required(values["machine-inventory"], "--machine-inventory");
  const outputPath = await outputOutsideRepository(required(values.output, "--output"));

  const prepared = await prepareClaudeQualificationInputs({
    pairPath,
    programsDirectory,
    machineInventoryPath,
  });
  const report = {
    schema: "signalbox/claude-qualification-preflight/v1",
    status: "candidate-inputs-verified",
    qualification: "pending",
    source: {
      commit: sourceField(prepared.pair.source, "commit"),
      sha256: sourceField(prepared.pair.source, "sha256"),
    },
    trustedComputer: prepared.computer.trustedComputer,
    componentVersions: prepared.componentVersions,
    variants: {
      baseline: summarize(prepared.variants.baseline),
      hooks: summarize(prepared.variants.hooks),
    },
    preparedModuleBytes: {
      baseline: prepared.variants.baseline.preparedModuleBytes,
      hooks: prepared.variants.hooks.preparedModuleBytes,
    },
    criteria: RELEASE_CRITERIA.map((name) => ({
      name,
      status: "pending",
      detail: "Input verification does not execute or qualify this scenario.",
    })),
    metrics: {
      bootTimeMs: {
        state: "unmeasured",
        reason: "No cold ProductClaude startup RPC was executed.",
      },
      peakHeapBytes: {
        state: "unmeasured",
        reason: "The 96 MiB configured-limit profile is rejected and calibration is censored.",
      },
    },
    resourceEvidence: {
      schema: "signalbox/claude-configured-limit-resource-evidence/v1",
      criterion: "configured-limit completion with measured overshoot",
      status: "pending",
      strictByteBound: false,
      calibrationPins: [],
      workloadCompletion: {
        status: "not-run",
        reason: "This command validates inputs only.",
      },
      sessionClose: { status: "not-started" },
      deployedPolicyEvidence: {
        status: "pending",
        label: "platform policy compliance evidence",
      },
    },
  };
  await writeFreshFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function summarize(variant: ClaudeQualificationPreparedVariant) {
  return {
    artifact: variant.artifact,
    preparedModuleBytes: variant.preparedModuleBytes,
    actualPreparedReleaseExpectedFromLoader: variant.expectedPreparedRelease,
  };
}

function required(value: string | undefined, flag: string) {
  if (value === undefined || value.length === 0) throw new Error(`Pass ${flag}.`);
  return value;
}

function sourceField(source: unknown, field: "commit" | "sha256") {
  if (typeof source !== "object" || source === null)
    throw new Error("CLAUDE_SOURCE_FREEZE_INVALID");
  const value = Reflect.get(source, field);
  if (typeof value !== "string") throw new Error("CLAUDE_SOURCE_FREEZE_INVALID");
  return value;
}

async function outputOutsideRepository(requested: string) {
  const repository = NodePath.resolve(import.meta.dirname, "../../../../../");
  const parent = NodePath.dirname(NodePath.resolve(requested));
  await NodeFSP.mkdir(parent, { recursive: true });
  const output = NodePath.join(await NodeFSP.realpath(parent), NodePath.basename(requested));
  const relative = NodePath.relative(await NodeFSP.realpath(repository), output);
  if (
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  )
    throw new Error("CLAUDE_QUALIFICATION_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  try {
    await NodeFSP.lstat(output);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return output;
    throw cause;
  }
  throw new Error("CLAUDE_QUALIFICATION_OUTPUT_EXISTS");
}

async function writeFreshFile(path: string, contents: string) {
  const file = await NodeFSP.open(path, "wx", 0o600);
  try {
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
}

if (process.argv[1] && (await NodeFSP.realpath(process.argv[1])) === import.meta.filename) {
  const report = await runClaudeQualificationCli(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify({ status: report.status, qualification: report.qualification })}\n`,
  );
}
