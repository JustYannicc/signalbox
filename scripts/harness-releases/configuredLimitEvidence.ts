import {
  isHarnessReleaseResourceCriteriaAssessment,
  type HarnessReleaseResourceCriteriaAssessment,
  type HarnessReleaseResourceStatus,
  type HarnessReleaseStartupUpperBound,
} from "@t3tools/shared/harnessReleaseResourceCriteria";
import {
  assessConfiguredLimitCompletion,
  classifyV8Termination,
  CONFIGURED_LIMIT_CRITERION,
  DEPLOYED_POLICY_CRITERION,
  type ConfiguredLimitCompletionInput,
  type V8TerminationEvidence,
} from "./configuredLimit.ts";

export const RESOURCE_EVIDENCE_TAG = "harness-release-resource-evidence-v1" as const;

export interface ResourceEvidencePins {
  readonly environment: "local-workerd" | "deployed";
  readonly measurementRunId: string;
  readonly fixtureId: string;
  readonly fixtureSha256: string;
  readonly artifactSha256: string;
  readonly releaseIdentitySha256: string;
}

export interface PublicQualifierConfiguredLimitInput {
  readonly configuredLimitBytes: number;
  readonly deltaMaxObservedBytes: number;
  readonly safetyMarginBytes: number;
  readonly budgetBytes: number;
  readonly calibrationComplete?: unknown;
  readonly workloadCompleted?: unknown;
  readonly identityVerified?: unknown;
}

export interface NormalPublicQualifierResourceEvidence {
  readonly tag: typeof RESOURCE_EVIDENCE_TAG;
  readonly source: "normal-public-qualifier";
  readonly environment: ResourceEvidencePins["environment"];
  readonly measurementRunId: string;
  readonly fixtureId: string;
  readonly fixtureSha256: string;
  readonly artifactSha256: string;
  readonly releaseIdentitySha256: string;
  readonly startupTiming: HarnessReleaseStartupUpperBound;
  readonly criterion:
    | {
        readonly label: typeof CONFIGURED_LIMIT_CRITERION;
        readonly configuredLimit: PublicQualifierConfiguredLimitInput;
        readonly termination?: unknown;
      }
    | {
        readonly label: typeof DEPLOYED_POLICY_CRITERION;
        readonly status: "pending" | "passed" | "rejected";
        readonly evidenceSha256: string;
        readonly identityVerified: boolean;
      };
}

export interface TrustedPublicQualifierResourceEvidence {
  readonly evidence: unknown;
  readonly expectedArtifactSha256: string;
  readonly expectedReleaseIdentitySha256: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const isResourceStatus = (value: unknown): value is HarnessReleaseResourceStatus =>
  value === "pending" || value === "passed" || value === "rejected";
const localCriterionKeys = new Set(["label", "configuredLimit", "termination"]);

function terminationClassification(value: unknown) {
  const evidence = asRecord(value);
  if (!evidence) throw new Error("RELEASE_RESOURCE_TERMINATION_INVALID");
  const allowed = new Set([
    "exitCode",
    "signal",
    "waited",
    "timedOut",
    "identityVerified",
    "allocationRequestVerified",
    "stderr",
  ]);
  if (Object.keys(evidence).some((key) => !allowed.has(key)))
    throw new Error("RELEASE_RESOURCE_TERMINATION_INVALID");
  return classifyV8Termination({
    exitCode: typeof evidence.exitCode === "number" ? evidence.exitCode : undefined,
    signal: typeof evidence.signal === "string" ? evidence.signal : undefined,
    waited: evidence.waited === true,
    timedOut: evidence.timedOut !== false,
    identityVerified: evidence.identityVerified === true,
    allocationRequestVerified: evidence.allocationRequestVerified === true,
    stderr: typeof evidence.stderr === "string" ? evidence.stderr : "",
  } as V8TerminationEvidence);
}

/** Recompute a separate public qualifier record against the runner's frozen pins. */
export function assessPublicQualifierResourceEvidence(
  value: unknown,
  expected: ResourceEvidencePins,
): HarnessReleaseResourceCriteriaAssessment {
  const evidence = asRecord(value);
  if (
    !evidence ||
    evidence.tag !== RESOURCE_EVIDENCE_TAG ||
    evidence.source !== "normal-public-qualifier" ||
    evidence.environment !== expected.environment ||
    evidence.measurementRunId !== expected.measurementRunId ||
    evidence.fixtureId !== expected.fixtureId ||
    evidence.fixtureSha256 !== expected.fixtureSha256 ||
    evidence.artifactSha256 !== expected.artifactSha256 ||
    evidence.releaseIdentitySha256 !== expected.releaseIdentitySha256 ||
    expected.releaseIdentitySha256 === "" ||
    !isHash(expected.fixtureSha256) ||
    !isHash(expected.artifactSha256) ||
    !isHash(expected.releaseIdentitySha256)
  )
    throw new Error("RELEASE_RESOURCE_EVIDENCE_PIN_MISMATCH");

  const pins = {
    measurementRunId: expected.measurementRunId,
    fixtureId: expected.fixtureId,
    fixtureSha256: expected.fixtureSha256,
    artifactSha256: expected.artifactSha256,
    releaseIdentitySha256: expected.releaseIdentitySha256,
  };
  const criterion = asRecord(evidence.criterion);
  if (!criterion) throw new Error("RELEASE_RESOURCE_CRITERION_INVALID");
  const startupUpperBound = evidence.startupTiming as HarnessReleaseStartupUpperBound;
  const base = {
    tag: "harness-release-resource-criteria-v1" as const,
    source: "normal-public-qualifier" as const,
    environment: expected.environment,
    pins,
    startupUpperBound,
  };
  let assessment: HarnessReleaseResourceCriteriaAssessment;

  if (expected.environment === "local-workerd") {
    if (
      !hasExactKeys(evidence, [
        "tag",
        "source",
        "environment",
        "measurementRunId",
        "fixtureId",
        "fixtureSha256",
        "artifactSha256",
        "releaseIdentitySha256",
        "startupTiming",
        "criterion",
      ]) ||
      criterion.label !== CONFIGURED_LIMIT_CRITERION ||
      !["label", "configuredLimit"].every((key) => key in criterion) ||
      Object.keys(criterion).some((key) => !localCriterionKeys.has(key))
    )
      throw new Error("RELEASE_RESOURCE_CRITERION_INVALID");
    const rawConfiguredLimit = asRecord(criterion.configuredLimit);
    const requiredLimitInputs = [
      "configuredLimitBytes",
      "deltaMaxObservedBytes",
      "safetyMarginBytes",
      "budgetBytes",
    ];
    const allowedLimitInputs = new Set([
      ...requiredLimitInputs,
      "calibrationComplete",
      "workloadCompleted",
      "identityVerified",
    ]);
    if (
      !rawConfiguredLimit ||
      requiredLimitInputs.some((key) => !(key in rawConfiguredLimit)) ||
      Object.keys(rawConfiguredLimit).some((key) => !allowedLimitInputs.has(key))
    )
      throw new Error("RELEASE_RESOURCE_CONFIGURED_LIMIT_INVALID");
    const configuredLimit = assessConfiguredLimitCompletion(
      rawConfiguredLimit as unknown as ConfiguredLimitCompletionInput,
    );
    const termination =
      criterion.termination === undefined
        ? undefined
        : terminationClassification(criterion.termination);
    if (
      termination &&
      termination !== "NO_VERIFIED_TERMINATION" &&
      configuredLimit.workloadCompleted
    )
      throw new Error("RELEASE_RESOURCE_TERMINATION_CONTRADICTS_COMPLETION");
    assessment = {
      ...base,
      status: configuredLimit.status,
      label: CONFIGURED_LIMIT_CRITERION,
      configuredLimit,
      ...(termination ? { terminationClassification: termination } : {}),
      detail: configuredLimit.detail,
    };
  } else {
    if (
      !hasExactKeys(evidence, [
        "tag",
        "source",
        "environment",
        "measurementRunId",
        "fixtureId",
        "fixtureSha256",
        "artifactSha256",
        "releaseIdentitySha256",
        "startupTiming",
        "criterion",
      ]) ||
      criterion.label !== DEPLOYED_POLICY_CRITERION ||
      !hasExactKeys(criterion, ["label", "status", "evidenceSha256", "identityVerified"]) ||
      !isResourceStatus(criterion.status) ||
      !isHash(criterion.evidenceSha256) ||
      typeof criterion.identityVerified !== "boolean"
    )
      throw new Error("RELEASE_RESOURCE_PLATFORM_POLICY_INVALID");
    const sourceStatus = criterion.status;
    const status: HarnessReleaseResourceStatus =
      sourceStatus === "rejected"
        ? "rejected"
        : criterion.identityVerified === true
          ? sourceStatus
          : "pending";
    assessment = {
      ...base,
      status,
      label: DEPLOYED_POLICY_CRITERION,
      platformPolicyCompliance: {
        label: DEPLOYED_POLICY_CRITERION,
        status,
        evidenceSha256: criterion.evidenceSha256,
        identityVerified: criterion.identityVerified,
      },
      detail:
        status === "passed"
          ? "Deployed platform policy compliance evidence passed."
          : status === "rejected"
            ? "Deployed platform policy compliance evidence was rejected."
            : "Deployed platform policy compliance evidence is incomplete.",
    };
  }

  if (!isHarnessReleaseResourceCriteriaAssessment(assessment, expected))
    throw new Error("RELEASE_RESOURCE_ASSESSMENT_INVALID");
  return assessment;
}
