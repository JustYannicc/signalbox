export type HarnessReleaseResourceStatus = "not-applicable" | "pending" | "passed" | "rejected";

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

export interface HarnessReleaseNonceResponse {
  readonly id: string;
  readonly method: string;
  readonly status: number;
  readonly isolateNonce: string;
}

export interface HarnessReleaseNonceProbe {
  readonly status: number;
  readonly isolateNonce: string;
}

export interface HarnessReleaseDeployedCollectorRecord {
  readonly measurementRunId: string;
  readonly deploymentId: string;
  readonly loaderId: string;
  readonly facetId: string;
  readonly selectedReleaseSha256: string;
  readonly responsePlanSha256: string;
  readonly workloadCompleted: boolean;
  readonly beforeProbe: HarnessReleaseNonceProbe;
  readonly responses: ReadonlyArray<HarnessReleaseNonceResponse>;
  readonly afterProbe: HarnessReleaseNonceProbe;
}

export interface HarnessReleasePlatformPolicyEvidence {
  readonly label: "platform policy compliance evidence";
  readonly status: HarnessReleaseResourceStatus;
  readonly identityVerified: boolean;
  readonly collectorRecord: HarnessReleaseDeployedCollectorRecord;
}

export interface HarnessReleaseResourceCriteriaAssessment {
  readonly tag: "harness-release-resource-criteria-v2";
  readonly source: "normal-public-qualifier";
  readonly environment: "local-workerd" | "deployed";
  readonly status: HarnessReleaseResourceStatus;
  readonly label: "platform policy compliance evidence";
  readonly pins: HarnessReleaseResourceCriteriaPins;
  readonly startupUpperBound: HarnessReleaseStartupUpperBound;
  readonly platformPolicyCompliance?: HarnessReleasePlatformPolicyEvidence;
  readonly terminationClassification?:
    | "NO_VERIFIED_TERMINATION"
    | "OTHER_TERMINATION"
    | "V8_HEAP_OOM_PROCESS_TERMINATED";
  readonly detail: string;
}

export interface HarnessReleaseExpectedResponse {
  readonly id: string;
  readonly method: string;
}

export interface HarnessReleaseExpectedDeployedContext {
  readonly deploymentId: string;
  readonly loaderId: string;
  readonly facetId: string;
  readonly responsePlanSha256: string;
  readonly expectedResponses: ReadonlyArray<HarnessReleaseExpectedResponse>;
}

export interface ExpectedHarnessReleaseResourcePins {
  readonly environment?: string;
  readonly measurementRunId?: string;
  readonly fixtureId?: string;
  readonly fixtureSha256?: string;
  readonly artifactSha256?: string;
  readonly releaseIdentitySha256?: string;
  readonly deployedContext?: HarnessReleaseExpectedDeployedContext;
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
  const validStatus = (candidate: unknown): candidate is HarnessReleaseResourceStatus =>
    candidate === "not-applicable" ||
    candidate === "pending" ||
    candidate === "passed" ||
    candidate === "rejected";
  const assessment = record(value);
  if (!assessment) return false;
  const environment = assessment.environment;
  if (
    assessment.tag !== "harness-release-resource-criteria-v2" ||
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
    ...(local
      ? "terminationClassification" in assessment
        ? ["terminationClassification"]
        : []
      : ["platformPolicyCompliance"]),
    "detail",
  ];
  if (
    !exactKeys(assessment, expectedAssessmentKeys) ||
    assessment.label !== "platform policy compliance evidence"
  )
    return false;
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
    const termination = assessment.terminationClassification;
    return (
      assessment.status === "not-applicable" &&
      (termination === undefined ||
        termination === "NO_VERIFIED_TERMINATION" ||
        termination === "OTHER_TERMINATION" ||
        termination === "V8_HEAP_OOM_PROCESS_TERMINATED")
    );
  }

  const policy = record(assessment.platformPolicyCompliance);
  const context = expected?.deployedContext;
  if (
    !policy ||
    !context ||
    !text(context.deploymentId) ||
    !text(context.loaderId) ||
    !text(context.facetId) ||
    !hash(context.responsePlanSha256) ||
    !Array.isArray(context.expectedResponses) ||
    context.expectedResponses.length === 0 ||
    !context.expectedResponses.every((response) => {
      const planned = record(response);
      return planned !== undefined && text(planned.id) && text(planned.method);
    }) ||
    new Set(context.expectedResponses.map((response) => response.id)).size !==
      context.expectedResponses.length ||
    !exactKeys(policy, ["label", "status", "identityVerified", "collectorRecord"]) ||
    policy.label !== "platform policy compliance evidence" ||
    (policy.status !== "pending" && policy.status !== "passed" && policy.status !== "rejected") ||
    typeof policy.identityVerified !== "boolean" ||
    assessment.status !== policy.status
  )
    return false;
  const collector = record(policy.collectorRecord);
  if (
    !collector ||
    !exactKeys(collector, [
      "measurementRunId",
      "deploymentId",
      "loaderId",
      "facetId",
      "selectedReleaseSha256",
      "responsePlanSha256",
      "workloadCompleted",
      "beforeProbe",
      "responses",
      "afterProbe",
    ]) ||
    collector.measurementRunId !== pins.measurementRunId ||
    collector.deploymentId !== context.deploymentId ||
    collector.loaderId !== context.loaderId ||
    collector.facetId !== context.facetId ||
    collector.selectedReleaseSha256 !== pins.artifactSha256 ||
    collector.responsePlanSha256 !== context.responsePlanSha256 ||
    !hash(collector.responsePlanSha256) ||
    typeof collector.workloadCompleted !== "boolean"
  )
    return false;
  const before = record(collector.beforeProbe);
  const after = record(collector.afterProbe);
  const responses = collector.responses;
  if (
    !before ||
    !exactKeys(before, ["status", "isolateNonce"]) ||
    !after ||
    !exactKeys(after, ["status", "isolateNonce"]) ||
    !Array.isArray(responses)
  )
    return false;
  const validProbe = (probe: Record<string, unknown>) =>
    exactKeys(probe, ["status", "isolateNonce"]) &&
    typeof probe.status === "number" &&
    Number.isInteger(probe.status) &&
    typeof probe.isolateNonce === "string";
  if (!validProbe(before) || !validProbe(after)) return false;
  const nonceSequence: Array<unknown> = [before.isolateNonce];
  let responsePlanMatches = responses.length === context.expectedResponses.length;
  for (const [index, actual] of responses.entries()) {
    const row = record(actual);
    const planned = context.expectedResponses[index];
    if (
      !row ||
      !exactKeys(row, ["id", "method", "status", "isolateNonce"]) ||
      typeof row.id !== "string" ||
      typeof row.method !== "string" ||
      typeof row.status !== "number" ||
      !Number.isInteger(row.status) ||
      typeof row.isolateNonce !== "string" ||
      (policy.status === "passed" && !planned)
    )
      return false;
    if (planned === undefined || row.id !== planned.id || row.method !== planned.method)
      responsePlanMatches = false;
    nonceSequence.push(row.isolateNonce);
  }
  nonceSequence.push(after.isolateNonce);
  const successful =
    before.status === 200 &&
    after.status === 200 &&
    responses.every((response) => record(response)?.status === 200);
  const noncesPresent = nonceSequence.every((nonce) => text(nonce));
  const nonceStable = noncesPresent && nonceSequence.every((nonce) => nonce === nonceSequence[0]);
  const complete = collector.workloadCompleted && responsePlanMatches && successful && nonceStable;
  return (
    policy.identityVerified === true &&
    (complete
      ? policy.status === "passed" && assessment.status === "passed"
      : policy.status === "rejected" && assessment.status === "rejected")
  );
};
