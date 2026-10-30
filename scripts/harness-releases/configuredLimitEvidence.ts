import {
  isExpectedDeployedContext,
  isCollectorRecord,
  type ExpectedDeployedQualifierContext,
} from "./deployedNonceCollector.ts";
export type { ExpectedDeployedQualifierContext } from "./deployedNonceCollector.ts";
import {
  isHarnessReleaseResourceCriteriaAssessment,
  type HarnessReleaseDeployedCollectorRecord,
  type HarnessReleasePlatformPolicyEvidence,
  type HarnessReleaseResourceCriteriaAssessment,
  type HarnessReleaseStartupUpperBound,
} from "@t3tools/shared/harnessReleaseResourceCriteria";
import {
  classifyV8Termination,
  DEPLOYED_POLICY_CRITERION,
  type V8TerminationEvidence,
} from "./configuredLimit.ts";

export const RESOURCE_EVIDENCE_TAG = "harness-release-resource-evidence-v2" as const;

export interface NormalPublicQualifierResourceEvidence {
  readonly tag: typeof RESOURCE_EVIDENCE_TAG;
  readonly source: "normal-public-qualifier";
  readonly environment: "local-workerd" | "deployed";
  readonly measurementRunId: string;
  readonly fixtureId: string;
  readonly fixtureSha256: string;
  readonly artifactSha256: string;
  readonly releaseIdentitySha256: string;
  readonly startupTiming: HarnessReleaseStartupUpperBound;
  readonly criterion:
    | {
        readonly label: typeof DEPLOYED_POLICY_CRITERION;
        readonly termination?: unknown;
      }
    | {
        readonly label: typeof DEPLOYED_POLICY_CRITERION;
        readonly collectorRecord: HarnessReleaseDeployedCollectorRecord;
      };
}

export interface TrustedPublicQualifierResourceEvidence {
  readonly evidence: unknown;
  readonly expectedArtifactSha256: string;
  readonly expectedReleaseIdentitySha256: string;
  readonly expectedDeployedContext?: ExpectedDeployedQualifierContext;
}

export interface ResourceEvidencePins {
  readonly environment: "local-workerd" | "deployed";
  readonly measurementRunId: string;
  readonly fixtureId: string;
  readonly fixtureSha256: string;
  readonly artifactSha256: string;
  readonly releaseIdentitySha256: string;
  readonly expectedDeployedContext?: ExpectedDeployedQualifierContext;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

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

function assessmentPins(expected: ResourceEvidencePins) {
  return {
    environment: expected.environment,
    measurementRunId: expected.measurementRunId,
    fixtureId: expected.fixtureId,
    fixtureSha256: expected.fixtureSha256,
    artifactSha256: expected.artifactSha256,
    releaseIdentitySha256: expected.releaseIdentitySha256,
    ...(expected.expectedDeployedContext
      ? { deployedContext: expected.expectedDeployedContext }
      : {}),
  };
}

/** Recompute policy status from the complete trusted collector record and its frozen context. */
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

  const baseKeys = [
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
  ];
  const criterion = asRecord(evidence.criterion);
  if (!criterion) throw new Error("RELEASE_RESOURCE_CRITERION_INVALID");
  const startupUpperBound = evidence.startupTiming as HarnessReleaseStartupUpperBound;
  const pins = {
    measurementRunId: expected.measurementRunId,
    fixtureId: expected.fixtureId,
    fixtureSha256: expected.fixtureSha256,
    artifactSha256: expected.artifactSha256,
    releaseIdentitySha256: expected.releaseIdentitySha256,
  };

  if (expected.environment === "local-workerd") {
    if (
      !hasExactKeys(evidence, baseKeys) ||
      criterion.label !== DEPLOYED_POLICY_CRITERION ||
      Object.keys(criterion).some((key) => !["label", "termination"].includes(key))
    )
      throw new Error("RELEASE_RESOURCE_LOCAL_POLICY_CLOSED");
    const termination =
      criterion.termination === undefined
        ? undefined
        : terminationClassification(criterion.termination);
    const assessment: HarnessReleaseResourceCriteriaAssessment = {
      tag: "harness-release-resource-criteria-v2",
      source: "normal-public-qualifier",
      environment: "local-workerd",
      status: "not-applicable",
      label: DEPLOYED_POLICY_CRITERION,
      pins,
      startupUpperBound,
      ...(termination ? { terminationClassification: termination } : {}),
      detail: "Local memory samples are diagnostic; policy qualification requires deployment.",
    };
    if (!isHarnessReleaseResourceCriteriaAssessment(assessment, assessmentPins(expected)))
      throw new Error("RELEASE_RESOURCE_ASSESSMENT_INVALID");
    return assessment;
  }

  const rawCollectorRecord = criterion.collectorRecord;
  if (
    !hasExactKeys(evidence, baseKeys) ||
    criterion.label !== DEPLOYED_POLICY_CRITERION ||
    !hasExactKeys(criterion, ["label", "collectorRecord"]) ||
    !isCollectorRecord(rawCollectorRecord)
  )
    throw new Error("RELEASE_RESOURCE_DEPLOYED_POLICY_INVALID");
  const context = expected.expectedDeployedContext;
  if (!isExpectedDeployedContext(context))
    throw new Error("RELEASE_RESOURCE_DEPLOYED_CONTEXT_MISSING");
  const collector = rawCollectorRecord;
  if (
    collector.measurementRunId !== expected.measurementRunId ||
    collector.deploymentId !== context.deploymentId ||
    collector.loaderId !== context.loaderId ||
    collector.facetId !== context.facetId ||
    collector.selectedReleaseSha256 !== expected.artifactSha256 ||
    collector.responsePlanSha256 !== context.responsePlanSha256
  )
    throw new Error("RELEASE_RESOURCE_COLLECTOR_PIN_MISMATCH");

  const sequence = [collector.beforeProbe, ...collector.responses, collector.afterProbe];
  const allSuccessful = sequence.every((observation) => {
    const row = asRecord(observation);
    return (
      row?.status === 200 && typeof row.isolateNonce === "string" && row.isolateNonce.length > 0
    );
  });
  const responsePlanMatches =
    collector.responses.length === context.expectedResponses.length &&
    collector.responses.every((response, index) => {
      const actual = asRecord(response);
      const planned = context.expectedResponses[index];
      return actual?.id === planned?.id && actual?.method === planned?.method;
    });
  const nonceValues = sequence.map((observation) => asRecord(observation)?.isolateNonce);
  const nonceStable = allSuccessful && nonceValues.every((nonce) => nonce === nonceValues[0]);
  const status =
    collector.workloadCompleted && responsePlanMatches && nonceStable ? "passed" : "rejected";
  const platformPolicyCompliance: HarnessReleasePlatformPolicyEvidence = {
    label: DEPLOYED_POLICY_CRITERION,
    status,
    identityVerified: true,
    collectorRecord: collector,
  };
  const assessment: HarnessReleaseResourceCriteriaAssessment = {
    tag: "harness-release-resource-criteria-v2",
    source: "normal-public-qualifier",
    environment: "deployed",
    status,
    label: DEPLOYED_POLICY_CRITERION,
    pins,
    startupUpperBound,
    platformPolicyCompliance,
    detail:
      status === "passed"
        ? "The completed deployed workload used one isolate nonce for every successful response."
        : "The deployed collector record shows an incomplete workload, response plan, or isolate nonce.",
  };
  if (!isHarnessReleaseResourceCriteriaAssessment(assessment, assessmentPins(expected)))
    throw new Error("RELEASE_RESOURCE_ASSESSMENT_INVALID");
  return assessment;
}
