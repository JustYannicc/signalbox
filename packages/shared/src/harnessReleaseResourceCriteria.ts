export type HarnessReleaseResourceStatus = "pending" | "passed" | "rejected";

export interface HarnessReleaseResourceCriteriaPins {
  readonly measurementRunId: string;
  readonly fixtureId: string;
  readonly fixtureSha256: string;
  readonly artifactSha256: string;
  readonly releaseIdentitySha256: string;
}

export interface HarnessReleaseStartupUpperBound {
  readonly label: "cold first-successful-RPC latency";
  readonly interpretation: "startup upper bound";
  readonly clock: "parent process.hrtime.bigint";
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly milliseconds: number;
  readonly includesRpc: true;
  readonly exactBootTime: false;
}

export interface HarnessReleaseConfiguredLimitAssessment {
  readonly criterion: "configured-limit completion with measured overshoot";
  readonly status: HarnessReleaseResourceStatus;
  readonly configuredLimitBytes: number;
  readonly deltaMaxObservedBytes: number;
  readonly safetyMarginBytes: number;
  readonly budgetBytes: number;
  readonly assessedBytes: number;
  readonly budgetFits: boolean;
  readonly calibrationComplete: boolean;
  readonly workloadCompleted: boolean;
  readonly identityVerified: boolean;
  readonly strictByteBound: false;
  readonly detail: string;
}

export interface HarnessReleasePlatformPolicyEvidence {
  readonly label: "platform policy compliance evidence";
  readonly status: HarnessReleaseResourceStatus;
  readonly evidenceSha256: string;
  readonly identityVerified: boolean;
}

export interface HarnessReleaseResourceCriteriaAssessment {
  readonly tag: "harness-release-resource-criteria-v1";
  readonly source: "normal-public-qualifier";
  readonly environment: "local-workerd" | "deployed";
  readonly status: HarnessReleaseResourceStatus;
  readonly label:
    | "configured-limit completion with measured overshoot"
    | "platform policy compliance evidence";
  readonly pins: HarnessReleaseResourceCriteriaPins;
  readonly startupUpperBound: HarnessReleaseStartupUpperBound;
  readonly configuredLimit?: HarnessReleaseConfiguredLimitAssessment;
  readonly platformPolicyCompliance?: HarnessReleasePlatformPolicyEvidence;
  readonly terminationClassification?:
    | "NO_VERIFIED_TERMINATION"
    | "OTHER_TERMINATION"
    | "V8_HEAP_OOM_PROCESS_TERMINATED";
  readonly detail: string;
}

export interface ExpectedHarnessReleaseResourcePins {
  readonly environment?: string;
  readonly measurementRunId?: string;
  readonly fixtureId?: string;
  readonly fixtureSha256?: string;
  readonly artifactSha256?: string;
  readonly releaseIdentitySha256?: string;
}

/** Shared fail-closed contract for the runner and serialized watcher policy. */
export const isHarnessReleaseResourceCriteriaAssessment = (
  value: unknown,
  expected?: ExpectedHarnessReleaseResourcePins,
) => {
  const record = (candidate: unknown): Record<string, unknown> | undefined =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : undefined;
  const exactKeys = (candidate: Record<string, unknown>, names: ReadonlyArray<string>) =>
    Object.keys(candidate).length === names.length && names.every((name) => name in candidate);
  const text = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.length > 0;
  const hash = (candidate: unknown) =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  const safeBytes = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  const validStatus = (candidate: unknown): candidate is HarnessReleaseResourceStatus =>
    candidate === "pending" || candidate === "passed" || candidate === "rejected";
  const assessment = record(value);
  if (!assessment) return false;
  const environment = assessment.environment;
  if (
    assessment.tag !== "harness-release-resource-criteria-v1" ||
    assessment.source !== "normal-public-qualifier" ||
    (environment !== "local-workerd" && environment !== "deployed") ||
    !validStatus(assessment.status) ||
    !text(assessment.detail)
  )
    return false;
  const local = environment === "local-workerd";
  const expectedAssessmentKeys = [
    "tag",
    "source",
    "environment",
    "status",
    "label",
    "pins",
    "startupUpperBound",
    local ? "configuredLimit" : "platformPolicyCompliance",
    ...(local && "terminationClassification" in assessment ? ["terminationClassification"] : []),
    "detail",
  ];
  if (!exactKeys(assessment, expectedAssessmentKeys)) return false;
  const pins = record(assessment.pins);
  if (
    !pins ||
    !exactKeys(pins, [
      "measurementRunId",
      "fixtureId",
      "fixtureSha256",
      "artifactSha256",
      "releaseIdentitySha256",
    ]) ||
    !text(pins.measurementRunId) ||
    !text(pins.fixtureId) ||
    !hash(pins.fixtureSha256) ||
    !hash(pins.artifactSha256) ||
    !hash(pins.releaseIdentitySha256) ||
    (expected?.environment !== undefined && expected.environment !== environment) ||
    (expected?.measurementRunId !== undefined &&
      expected.measurementRunId !== pins.measurementRunId) ||
    (expected?.fixtureId !== undefined && expected.fixtureId !== pins.fixtureId) ||
    (expected?.fixtureSha256 !== undefined && expected.fixtureSha256 !== pins.fixtureSha256) ||
    (expected?.artifactSha256 !== undefined && expected.artifactSha256 !== pins.artifactSha256) ||
    (expected?.releaseIdentitySha256 !== undefined &&
      expected.releaseIdentitySha256 !== pins.releaseIdentitySha256)
  )
    return false;
  const timing = record(assessment.startupUpperBound);
  if (
    !timing ||
    !exactKeys(timing, [
      "label",
      "interpretation",
      "clock",
      "startedMonotonicNs",
      "finishedMonotonicNs",
      "milliseconds",
      "includesRpc",
      "exactBootTime",
    ]) ||
    timing.label !== "cold first-successful-RPC latency" ||
    timing.interpretation !== "startup upper bound" ||
    timing.clock !== "parent process.hrtime.bigint" ||
    !text(timing.startedMonotonicNs) ||
    !/^\d+$/u.test(timing.startedMonotonicNs) ||
    !text(timing.finishedMonotonicNs) ||
    !/^\d+$/u.test(timing.finishedMonotonicNs) ||
    typeof timing.milliseconds !== "number" ||
    !Number.isFinite(timing.milliseconds) ||
    timing.milliseconds < 0 ||
    timing.includesRpc !== true ||
    timing.exactBootTime !== false
  )
    return false;
  try {
    const elapsed = BigInt(timing.finishedMonotonicNs) - BigInt(timing.startedMonotonicNs);
    if (elapsed < 0n || timing.milliseconds !== Number(elapsed) / 1e6) return false;
  } catch {
    return false;
  }

  if (local) {
    if (assessment.label !== "configured-limit completion with measured overshoot") return false;
    const configured = record(assessment.configuredLimit);
    if (
      !configured ||
      !exactKeys(configured, [
        "criterion",
        "status",
        "configuredLimitBytes",
        "deltaMaxObservedBytes",
        "safetyMarginBytes",
        "budgetBytes",
        "assessedBytes",
        "budgetFits",
        "calibrationComplete",
        "workloadCompleted",
        "identityVerified",
        "strictByteBound",
        "detail",
      ]) ||
      configured.criterion !== "configured-limit completion with measured overshoot" ||
      !validStatus(configured.status) ||
      !text(configured.detail) ||
      typeof configured.budgetFits !== "boolean" ||
      typeof configured.calibrationComplete !== "boolean" ||
      typeof configured.workloadCompleted !== "boolean" ||
      typeof configured.identityVerified !== "boolean" ||
      configured.strictByteBound !== false
    )
      return false;
    const limit = configured.configuredLimitBytes;
    const delta = configured.deltaMaxObservedBytes;
    const margin = configured.safetyMarginBytes;
    const budget = configured.budgetBytes;
    const assessed = configured.assessedBytes;
    if (
      !safeBytes(limit) ||
      !safeBytes(delta) ||
      !safeBytes(margin) ||
      !safeBytes(budget) ||
      !safeBytes(assessed) ||
      limit === 0 ||
      budget === 0 ||
      !Number.isSafeInteger(limit + delta + margin) ||
      assessed !== limit + delta + margin ||
      configured.budgetFits !== assessed <= budget
    )
      return false;
    let configuredStatus: HarnessReleaseResourceStatus = configured.budgetFits
      ? configured.calibrationComplete &&
        configured.workloadCompleted &&
        configured.identityVerified
        ? "passed"
        : "pending"
      : "rejected";
    if ("terminationClassification" in assessment) {
      const termination = assessment.terminationClassification;
      if (
        termination !== "NO_VERIFIED_TERMINATION" &&
        termination !== "OTHER_TERMINATION" &&
        termination !== "V8_HEAP_OOM_PROCESS_TERMINATED"
      )
        return false;
      if (
        termination !== "NO_VERIFIED_TERMINATION" &&
        (configured.workloadCompleted || configuredStatus === "passed")
      )
        return false;
    }
    if (configured.status !== configuredStatus || assessment.status !== configuredStatus)
      return false;
    return true;
  }

  if (assessment.label !== "platform policy compliance evidence") return false;
  const policy = record(assessment.platformPolicyCompliance);
  if (
    !policy ||
    !exactKeys(policy, ["label", "status", "evidenceSha256", "identityVerified"]) ||
    policy.label !== "platform policy compliance evidence" ||
    !validStatus(policy.status) ||
    !hash(policy.evidenceSha256) ||
    typeof policy.identityVerified !== "boolean" ||
    (policy.status === "passed" && policy.identityVerified !== true) ||
    assessment.status !== policy.status
  )
    return false;
  return true;
};
