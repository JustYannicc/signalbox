import type { HarnessReleaseDeployedCollectorRecord } from "@t3tools/shared/harnessReleaseResourceCriteria";
import type { HarnessReleaseExpectedResponse } from "@t3tools/shared/harnessReleaseResourceCriteria";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

export interface ExpectedDeployedQualifierContext {
  readonly deploymentId: string;
  readonly loaderId: string;
  readonly facetId: string;
  readonly responsePlanSha256: string;
  readonly expectedResponses: ReadonlyArray<HarnessReleaseExpectedResponse>;
}

export function isExpectedDeployedContext(
  value: unknown,
): value is ExpectedDeployedQualifierContext {
  const context = asRecord(value);
  if (
    !context ||
    !hasExactKeys(context, [
      "deploymentId",
      "loaderId",
      "facetId",
      "responsePlanSha256",
      "expectedResponses",
    ]) ||
    typeof context.deploymentId !== "string" ||
    !context.deploymentId ||
    typeof context.loaderId !== "string" ||
    !context.loaderId ||
    typeof context.facetId !== "string" ||
    !context.facetId ||
    !isHash(context.responsePlanSha256) ||
    !Array.isArray(context.expectedResponses) ||
    context.expectedResponses.length === 0
  )
    return false;
  return (
    new Set(context.expectedResponses.map((response) => asRecord(response)?.id)).size ===
      context.expectedResponses.length &&
    context.expectedResponses.every((response) => {
      const row = asRecord(response);
      return (
        row !== undefined &&
        hasExactKeys(row, ["id", "method"]) &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        typeof row.method === "string" &&
        row.method.length > 0
      );
    })
  );
}

export function isCollectorRecord(value: unknown): value is HarnessReleaseDeployedCollectorRecord {
  const collector = asRecord(value);
  if (
    !collector ||
    !hasExactKeys(collector, [
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
    typeof collector.measurementRunId !== "string" ||
    typeof collector.deploymentId !== "string" ||
    typeof collector.loaderId !== "string" ||
    typeof collector.facetId !== "string" ||
    !isHash(collector.selectedReleaseSha256) ||
    !isHash(collector.responsePlanSha256) ||
    typeof collector.workloadCompleted !== "boolean" ||
    !asRecord(collector.beforeProbe) ||
    !Array.isArray(collector.responses) ||
    !asRecord(collector.afterProbe)
  )
    return false;
  const validProbe = (probe: unknown) => {
    const row = asRecord(probe);
    return (
      row !== undefined &&
      hasExactKeys(row, ["status", "isolateNonce"]) &&
      typeof row.status === "number" &&
      Number.isInteger(row.status) &&
      typeof row.isolateNonce === "string"
    );
  };
  return (
    validProbe(collector.beforeProbe) &&
    validProbe(collector.afterProbe) &&
    collector.responses.every((response) => {
      const row = asRecord(response);
      return (
        row !== undefined &&
        hasExactKeys(row, ["id", "method", "status", "isolateNonce"]) &&
        typeof row.id === "string" &&
        typeof row.method === "string" &&
        typeof row.status === "number" &&
        Number.isInteger(row.status) &&
        typeof row.isolateNonce === "string"
      );
    })
  );
}
