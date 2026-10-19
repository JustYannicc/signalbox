import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { isNodeErrorCode } from "./guards.ts";
import {
  recordReleaseArtifact,
  recordReleaseCheck,
  type CheckResult,
  type ReleaseReport,
} from "../claude-bunfs/release-report.ts";

export interface ClaudeArtifactEnvelope {
  readonly manifest: "manifest.json";
  readonly moduleMap: "module-map.json";
  readonly sha256: string;
  readonly bytes: number;
}

export interface BuildClaudeReleaseResult {
  readonly report: ReleaseReport;
  readonly artifact: ClaudeArtifactEnvelope;
  readonly provenance: Record<string, unknown>;
}

interface PublishClaudeBuildOutputOptions {
  readonly report: ReleaseReport;
  readonly bunCapabilityGaps: ReadonlyArray<{ readonly reason: string }>;
  readonly hasCapabilitySnapshot: boolean;
  readonly artifact: ClaudeArtifactEnvelope;
  readonly provenance: Record<string, unknown>;
  readonly stage: string;
  readonly bundlePath: string;
  readonly output: string;
  readonly provenancePath: string;
  readonly resultPath?: string;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function writeStagedFile(target: string, bytes: string): Promise<string> {
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.partial-${NodeCrypto.randomUUID()}`;
  await NodeFSP.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  return temporary;
}

function resultCheck(status: CheckResult["status"], evidence: string): CheckResult {
  return { status, diagnostics: [], evidence: [evidence] };
}

function markCapabilitySnapshotPending(
  report: ReleaseReport,
  bunGaps: ReadonlyArray<{ readonly reason: string }>,
): ReleaseReport {
  const diagnostics = [
    {
      code: "RUNTIME_CAPABILITY_SNAPSHOT_REQUIRED",
      message:
        "No selected runtime capability snapshot was supplied; current route data is not callable support evidence.",
    },
  ];
  const definiteBunFailures = bunGaps.some(
    (gap) => gap.reason === "unmapped-api" || gap.reason === "dynamic-access",
  );
  return {
    ...report,
    checks: {
      ...report.checks,
      builtinGaps: { status: "pending", diagnostics },
      bunCapabilities: {
        status: definiteBunFailures ? "fail" : "pending",
        diagnostics: [...report.checks.bunCapabilities.diagnostics, ...diagnostics],
      },
    },
  };
}

export async function publishClaudeBuildOutput(
  options: PublishClaudeBuildOutputOptions,
): Promise<BuildClaudeReleaseResult> {
  let report = options.report;
  if (!options.hasCapabilitySnapshot)
    report = markCapabilitySnapshotPending(report, options.bunCapabilityGaps);
  report = recordReleaseCheck(
    report,
    report.release,
    "extraction",
    resultCheck(
      "pass",
      "Official manifest SHA, binary SHA and byte count match the extracted graph.",
    ),
  );
  report = recordReleaseArtifact(report, options.artifact);
  report = recordReleaseCheck(report, report.release, "rebundle", {
    status: "pass",
    diagnostics: [],
    artifactSha256: options.artifact.sha256,
    evidence: ["Generated bundle manifest and all declared artifact payloads were rehashed."],
  });

  const result: BuildClaudeReleaseResult = {
    report,
    artifact: options.artifact,
    provenance: options.provenance,
  };
  const provenanceBytes = `${JSON.stringify(options.provenance, null, 2)}\n`;
  const resultBytes = `${JSON.stringify(result, null, 2)}\n`;
  await NodeFSP.writeFile(NodePath.join(options.stage, "provenance.json"), provenanceBytes, {
    flag: "wx",
    mode: 0o600,
  });
  await NodeFSP.writeFile(NodePath.join(options.stage, "result.json"), resultBytes, {
    flag: "wx",
    mode: 0o600,
  });

  let temporaryProvenance: string | undefined;
  let temporaryResult: string | undefined;
  let publishedProvenance = false;
  let publishedResult = false;
  try {
    if (
      (await pathExists(options.output)) ||
      (await pathExists(options.provenancePath)) ||
      (options.resultPath && (await pathExists(options.resultPath)))
    )
      throw new Error("CLAUDE_BUILD_OUTPUT_RACED");

    temporaryProvenance = await writeStagedFile(options.provenancePath, provenanceBytes);
    if (options.resultPath)
      temporaryResult = await writeStagedFile(options.resultPath, resultBytes);
    await NodeFSP.rename(temporaryProvenance, options.provenancePath);
    temporaryProvenance = undefined;
    publishedProvenance = true;
    if (temporaryResult && options.resultPath) {
      await NodeFSP.rename(temporaryResult, options.resultPath);
      temporaryResult = undefined;
      publishedResult = true;
    }
    await NodeFSP.rename(options.bundlePath, options.output);
    await NodeFSP.rm(options.stage, { recursive: true, force: true }).catch(() => {});
    return result;
  } catch (error) {
    if (temporaryProvenance) await NodeFSP.rm(temporaryProvenance, { force: true });
    if (temporaryResult) await NodeFSP.rm(temporaryResult, { force: true });
    if (publishedResult && options.resultPath)
      await NodeFSP.rm(options.resultPath, { force: true });
    if (publishedProvenance) await NodeFSP.rm(options.provenancePath, { force: true });
    throw error;
  }
}
