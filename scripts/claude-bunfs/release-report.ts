import type { ClaudeReleaseInventory } from "./release-inventory.ts";
import type { ReleaseBuiltinGap } from "./builtin-gap.ts";
import type { CodegenFinding } from "./codegen-inventory.ts";

export const releaseChecks = [
  "extraction",
  "inventory",
  "bunCapabilities",
  "builtinGaps",
  "codegen",
  "rebundle",
  "localWorkerd",
  "deployedDO",
  "updateProof",
] as const;

export type ReleaseCheck = (typeof releaseChecks)[number];
const artifactChecks = ["rebundle", "localWorkerd", "deployedDO", "updateProof"] as const;
export interface CheckResult {
  readonly status: "pass" | "fail" | "pending";
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly evidence?: ReadonlyArray<string>;
  readonly artifactSha256?: string;
}
export interface ReleaseArtifact {
  readonly manifest: string;
  readonly moduleMap: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface ReleaseReport {
  readonly schemaVersion: 1;
  readonly release: {
    readonly provider: "claude-code";
    readonly version: string;
    readonly platform: string;
    readonly binarySha256: string;
    readonly bunVersion: string | null;
  };
  readonly inventory: ClaudeReleaseInventory | null;
  readonly builtinGaps: ReadonlyArray<ReleaseBuiltinGap>;
  readonly codegenFindings: ReadonlyArray<CodegenFinding>;
  readonly artifact: ReleaseArtifact | null;
  readonly checks: Readonly<Record<ReleaseCheck, CheckResult>>;
}

/** Runtime and update-proof evidence must be supplied separately for this exact binary. */
export function createReleaseReport(release: ReleaseReport["release"]): ReleaseReport {
  const pending = (): CheckResult => ({ status: "pending", diagnostics: [] });
  return {
    schemaVersion: 1,
    release,
    inventory: null,
    builtinGaps: [],
    codegenFindings: [],
    artifact: null,
    checks: {
      extraction: pending(),
      inventory: pending(),
      bunCapabilities: pending(),
      builtinGaps: pending(),
      codegen: pending(),
      rebundle: pending(),
      localWorkerd: pending(),
      deployedDO: pending(),
      updateProof: pending(),
    },
  };
}

export function recordReleaseCheck(
  report: ReleaseReport,
  identity: ReleaseReport["release"],
  check: ReleaseCheck,
  result: CheckResult,
): ReleaseReport {
  if (
    identity.provider !== report.release.provider ||
    identity.version !== report.release.version ||
    identity.platform !== report.release.platform ||
    identity.binarySha256 !== report.release.binarySha256 ||
    identity.bunVersion !== report.release.bunVersion
  )
    throw new Error("RELEASE_EVIDENCE_IDENTITY_MISMATCH");
  if (
    artifactChecks.some((name) => name === check) &&
    result.status === "pass" &&
    (!report.artifact || result.artifactSha256 !== report.artifact.sha256)
  )
    throw new Error("RELEASE_EVIDENCE_ARTIFACT_MISMATCH");
  return { ...report, checks: { ...report.checks, [check]: result } };
}

export function recordReleaseArtifact(
  report: ReleaseReport,
  artifact: ReleaseArtifact,
): ReleaseReport {
  if (report.artifact?.sha256 === artifact.sha256) return { ...report, artifact };
  return {
    ...report,
    artifact,
    checks: {
      ...report.checks,
      rebundle: { status: "pending", diagnostics: [] },
      localWorkerd: { status: "pending", diagnostics: [] },
      deployedDO: { status: "pending", diagnostics: [] },
      updateProof: { status: "pending", diagnostics: [] },
    },
  };
}

export function assertReleaseIsPublishable(report: ReleaseReport): void {
  if (
    report.inventory &&
    (report.inventory.binary.sha256 !== report.release.binarySha256 ||
      report.inventory.release.version !== report.release.version ||
      report.inventory.release.platform !== report.release.platform ||
      report.inventory.release.bunVersion !== report.release.bunVersion)
  )
    throw new Error("RELEASE_INVENTORY_IDENTITY_MISMATCH");
  const failures = releaseChecks.filter((check) => report.checks[check].status !== "pass");
  if (!report.inventory) failures.push("inventory");
  if (!report.artifact) failures.push("rebundle");
  for (const check of artifactChecks)
    if (report.checks[check].artifactSha256 !== report.artifact?.sha256) failures.push(check);
  if (failures.length) throw new Error(`RELEASE_NOT_GREEN: ${[...new Set(failures)].join(", ")}`);
}
