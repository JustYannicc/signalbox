import { DateTime, Effect } from "effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { writeClaudeReleaseLedgerCandidate } from "./writeClaudeReleaseLedgerCandidate.ts";

const usage = `Usage: node --experimental-strip-types writeClaudeReleaseLedgerCandidateCli.ts \\
  --baseline-directory DIR --baseline-artifact-ref REF --baseline-artifact-hash SHA256 \\
  --baseline-source-identity SHA256 --hooks-directory DIR --hooks-artifact-ref REF \\
  --hooks-artifact-hash SHA256 --hooks-source-identity SHA256 \\
  --computer-source-identity SHA256 --computer-manifest-sha256 SHA256 \\
  --max-prepared-module-bytes BYTES --output DIRECTORY [--project-id ID]`;

const required = (value: string | undefined, option: string) => {
  if (!value) throw new Error(`Pass --${option}.`);
  return value;
};

export async function runClaudeReleaseLedgerCandidateCli(args: readonly string[]) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      help: { type: "boolean", short: "h" },
      "baseline-directory": { type: "string" },
      "baseline-artifact-ref": { type: "string" },
      "baseline-artifact-hash": { type: "string" },
      "baseline-source-identity": { type: "string" },
      "hooks-directory": { type: "string" },
      "hooks-artifact-ref": { type: "string" },
      "hooks-artifact-hash": { type: "string" },
      "hooks-source-identity": { type: "string" },
      "computer-source-identity": { type: "string" },
      "computer-manifest-sha256": { type: "string" },
      "max-prepared-module-bytes": { type: "string" },
      "project-id": { type: "string" },
      output: { type: "string" },
    },
  });
  if (values.help) {
    return null;
  }

  const maxPreparedModuleBytes = Number(
    required(values["max-prepared-module-bytes"], "max-prepared-module-bytes"),
  );
  if (!Number.isSafeInteger(maxPreparedModuleBytes) || maxPreparedModuleBytes <= 0)
    throw new Error("HARNESS_CANDIDATE_MODULE_ALLOWANCE_INVALID");

  const createdAt = DateTime.formatIso(await Effect.runPromise(DateTime.now));
  const result = await writeClaudeReleaseLedgerCandidate({
    createdAt,
    baseline: {
      directory: NodePath.resolve(required(values["baseline-directory"], "baseline-directory")),
      identity: {
        artifactRef: required(values["baseline-artifact-ref"], "baseline-artifact-ref"),
        artifactHash: required(values["baseline-artifact-hash"], "baseline-artifact-hash"),
        sourceIdentity: required(values["baseline-source-identity"], "baseline-source-identity"),
      },
    },
    hooks: {
      directory: NodePath.resolve(required(values["hooks-directory"], "hooks-directory")),
      identity: {
        artifactRef: required(values["hooks-artifact-ref"], "hooks-artifact-ref"),
        artifactHash: required(values["hooks-artifact-hash"], "hooks-artifact-hash"),
        sourceIdentity: required(values["hooks-source-identity"], "hooks-source-identity"),
      },
    },
    trustedComputer: {
      sourceIdentity: required(values["computer-source-identity"], "computer-source-identity"),
      manifestSha256: required(values["computer-manifest-sha256"], "computer-manifest-sha256"),
    },
    maxPreparedModuleBytes,
    ...(values["project-id"] === undefined ? {} : { projectId: values["project-id"] }),
    outputDirectory: NodePath.resolve(required(values.output, "output")),
  });

  return result;
}

if (process.argv[1] && (await NodeFSP.realpath(process.argv[1])) === import.meta.filename) {
  try {
    const result = await runClaudeReleaseLedgerCandidateCli(process.argv.slice(2));
    if (!result) process.stdout.write(`${usage}\n`);
    else
      process.stdout.write(
        `${JSON.stringify({
          schema: result.descriptor.schema,
          status: result.descriptor.status,
          qualification: result.descriptor.qualification,
          scope: result.descriptor.scope,
          candidateFile: result.candidateFile,
          ledgerFile: result.ledgerFile,
          eligibility: result.descriptor.eligibility,
        })}\n`,
      );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
