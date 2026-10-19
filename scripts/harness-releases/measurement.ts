import { object, type FrozenFixture } from "./fixture.ts";

export type ProofEnvironment = "local-workerd" | "deployed";

export const RELEASE_CRITERIA = [
  "boot",
  "text",
  "readEdit",
  "bash",
  "grep",
  "resume",
  "mcp",
  "interrupt",
  "publicHarness",
] as const;

export type ReleaseCriterion = (typeof RELEASE_CRITERIA)[number];
export type ReleaseMetric =
  | { readonly state: "measured"; readonly value: number }
  | { readonly state: "unmeasured"; readonly reason: string };

export interface ReleaseCriteriaAssessment {
  readonly checks: ReadonlyArray<{
    readonly name: ReleaseCriterion;
    readonly status: "pending" | "passed" | "rejected";
    readonly detail: string;
  }>;
  readonly metrics: {
    readonly moduleBytes: ReleaseMetric;
    readonly bootTimeMs: ReleaseMetric;
    readonly peakHeapBytes: ReleaseMetric;
  };
}

/** Generic probe verification also accepts results without an assertion. Release proof requires it. */
export function verifyMeasurement(
  fixture: FrozenFixture,
  value: unknown,
  environment: ProofEnvironment,
) {
  const measurement = object(value);
  if (measurement.schemaVersion !== 1 || measurement.environment !== environment)
    throw new Error("RELEASE_PROOF_ENVIRONMENT_MISMATCH");
  if (typeof measurement.runId !== "string" || !measurement.runId)
    throw new Error("RELEASE_PROOF_RUN_ID_MISSING");
  if (!Array.isArray(measurement.verificationErrors) || measurement.verificationErrors.length)
    throw new Error("RELEASE_PROOF_VERIFICATION_FAILED");
  const rows = measurement.rows;
  if (!Array.isArray(rows) || rows.length !== fixture.requests.length)
    throw new Error("RELEASE_PROOF_REQUEST_COUNT_MISMATCH");
  const results = [];
  for (const [index, raw] of rows.entries()) {
    const row = object(raw);
    const expected = fixture.requests[index]!;
    if (row.fixture !== fixture.id || row.path !== expected.path || row.cold !== (index === 0))
      throw new Error("RELEASE_PROOF_REQUEST_MISMATCH");
    if (!Array.isArray(row.inventory) || row.inventory.length !== fixture.inventory.length)
      throw new Error("RELEASE_PROOF_INVENTORY_MISMATCH");
    const inventory = row.inventory
      .map(object)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const [position, actual] of inventory.entries()) {
      const pinned = fixture.inventory[position]!;
      for (const key of ["name", "type", "bytes", "sha256"] as const)
        if (actual[key] !== pinned[key]) throw new Error("RELEASE_PROOF_INVENTORY_MISMATCH");
    }
    if (row.request !== undefined) {
      const request = object(row.request);
      if (
        request.path !== expected.path ||
        request.method !== expected.method ||
        request.contentType !== expected.contentType
      )
        throw new Error("RELEASE_PROOF_REQUEST_MISMATCH");
      if (expected.payload) {
        const payload = object(request.payload);
        for (const key of ["bytes", "sha256", "bodyFile"] as const)
          if (payload[key] !== expected.payload[key])
            throw new Error("RELEASE_PROOF_PAYLOAD_MISMATCH");
      } else if (request.payload !== undefined) throw new Error("RELEASE_PROOF_PAYLOAD_MISMATCH");
    } else if (expected.payload || expected.method !== "GET" || expected.contentType !== undefined)
      throw new Error("RELEASE_PROOF_REQUEST_MISSING");
    const response = object(row.response);
    if (response.status !== 200 || response.error !== undefined)
      throw new Error("RELEASE_PROOF_HTTP_FAILED");
    const result = object(response.result);
    if (result.ok !== true) throw new Error("RELEASE_PROOF_BEHAVIOR_FAILED");
    if (
      typeof row.clientWallMs !== "number" ||
      !Number.isFinite(row.clientWallMs) ||
      row.clientWallMs < 0
    )
      throw new Error("RELEASE_PROOF_DURATION_MISSING");
    results.push({ path: expected.path, clientWallMs: row.clientWallMs, result });
  }
  return { environment, runId: measurement.runId, results };
}

export function verifyReleaseCriteria(
  fixture: FrozenFixture,
  raw: unknown,
  environment: ProofEnvironment,
): ReleaseCriteriaAssessment {
  verifyMeasurement(fixture, raw, environment);
  // The existing probe's `ok` assertion has no scenario contract for these release gates.
  // Only the public Harness proof adapter may establish them when its protocol is available.
  return {
    checks: RELEASE_CRITERIA.map((name) => ({
      name,
      status: "pending",
      detail: "The public Harness scenario verifier is not available for this fixture.",
    })),
    metrics: {
      moduleBytes: {
        state: "measured",
        value: fixture.inventory.reduce((bytes, module) => bytes + module.bytes, 0),
      },
      bootTimeMs: {
        state: "unmeasured",
        reason: "Client request duration does not isolate Harness boot time.",
      },
      peakHeapBytes: {
        state: "unmeasured",
        reason: "The probe does not measure peak heap in the session facet.",
      },
    },
  };
}
