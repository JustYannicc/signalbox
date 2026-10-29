import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { assertFixtureUnchanged, freezeFixture, type FrozenFixture } from "./fixture.ts";
import { RELEASE_CRITERIA, verifyMeasurement, verifyReleaseCriteria } from "./measurement.ts";
import { CONFIGURED_LIMIT_CRITERION, DEPLOYED_POLICY_CRITERION } from "./configuredLimit.ts";
import { RESOURCE_EVIDENCE_TAG } from "./configuredLimitEvidence.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "1072-fixture-"));
  directories.push(root);
  await NodeFSP.writeFile(NodePath.join(root, "main.js"), "export class Proof {}");
  await NodeFSP.writeFile(NodePath.join(root, "assets.bin"), Uint8Array.of(0, 255, 128));
  const manifest = {
    id: "official-turn",
    mode: "facet",
    mainModule: "main.js",
    entrypoint: "Proof",
    modules: { "main.js": { path: "main.js", type: "js" } },
    requests: [
      {
        path: "/seed",
        method: "POST",
        bodyFile: "assets.bin",
        contentType: "application/octet-stream",
      },
      { path: "/turn" },
    ],
  };
  await NodeFSP.writeFile(NodePath.join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, manifest, frozen: await freezeFixture(root) };
}

function measurement(frozen: FrozenFixture) {
  return {
    schemaVersion: 1,
    environment: "local-workerd",
    runId: "native-fixture-run",
    verificationErrors: [],
    rows: frozen.requests.map((request, index) => ({
      fixture: frozen.id,
      path: request.path,
      cold: index === 0,
      request,
      inventory: frozen.inventory.map((entry) => ({ ...entry })),
      clientWallMs: 12,
      response: { status: 200, result: { ok: true } },
    })),
  };
}

const startupTiming = {
  label: "cold first-successful-RPC latency",
  interpretation: "startup upper bound",
  clock: "parent process.hrtime.bigint",
  startedMonotonicNs: "100",
  finishedMonotonicNs: "110",
  milliseconds: 0.00001,
  includesRpc: true,
  exactBootTime: false,
} as const;

function resourceEvidence(
  frozen: FrozenFixture,
  environment: "local-workerd" | "deployed",
  criterion?: Record<string, unknown>,
) {
  return {
    tag: RESOURCE_EVIDENCE_TAG,
    source: "normal-public-qualifier",
    environment,
    measurementRunId: "native-fixture-run",
    fixtureId: frozen.id,
    fixtureSha256: frozen.sha256,
    artifactSha256: "c".repeat(64),
    releaseIdentitySha256: "b".repeat(64),
    startupTiming,
    criterion:
      criterion ??
      (environment === "local-workerd"
        ? {
            label: CONFIGURED_LIMIT_CRITERION,
            configuredLimit: {
              configuredLimitBytes: 64,
              deltaMaxObservedBytes: 4,
              safetyMarginBytes: 8,
              budgetBytes: 128,
              calibrationComplete: true,
              workloadCompleted: true,
              identityVerified: true,
            },
          }
        : {
            label: DEPLOYED_POLICY_CRITERION,
            status: "passed",
            evidenceSha256: "d".repeat(64),
            identityVerified: true,
          }),
  };
}

describe("release proof identity", () => {
  it("keeps unproven release scenarios pending despite arbitrary green claims", async () => {
    const { frozen } = await fixture();
    const raw = {
      ...measurement(frozen),
      checks: Object.fromEntries(RELEASE_CRITERIA.map((name) => [name, "passed"])),
      peakHeapBytes: 100,
      bootTimeMs: 1,
      resourceCriteria: { tag: "harness-release-resource-criteria-v1", status: "passed" },
    };
    const assessed = verifyReleaseCriteria(frozen, raw, "local-workerd");
    expect(assessed.checks.every((check) => check.status === "pending")).toBe(true);
    expect(assessed.metrics.moduleBytes).toEqual({
      state: "measured",
      value: frozen.inventory.reduce((bytes, module) => bytes + module.bytes, 0),
    });
    expect(assessed.metrics.bootTimeMs.state).toBe("unmeasured");
    expect(assessed.metrics.peakHeapBytes.state).toBe("unmeasured");
    expect(assessed.resourceCriteria).toBeUndefined();
    raw.rows[1]!.response.result.ok = false;
    expect(() => verifyReleaseCriteria(frozen, raw, "local-workerd")).toThrow("BEHAVIOR_FAILED");
  });

  it("recomputes tagged local evidence from separately pinned public qualifier input", async () => {
    const { frozen } = await fixture();
    const assessed = verifyReleaseCriteria(frozen, measurement(frozen), "local-workerd", {
      evidence: resourceEvidence(frozen, "local-workerd"),
      expectedArtifactSha256: "c".repeat(64),
      expectedReleaseIdentitySha256: "b".repeat(64),
    });
    expect(assessed.resourceCriteria).toMatchObject({
      tag: "harness-release-resource-criteria-v1",
      source: "normal-public-qualifier",
      environment: "local-workerd",
      status: "passed",
      label: CONFIGURED_LIMIT_CRITERION,
      startupUpperBound: {
        interpretation: "startup upper bound",
        includesRpc: true,
        exactBootTime: false,
      },
      configuredLimit: { status: "passed", assessedBytes: 76, strictByteBound: false },
    });
    expect(assessed.checks.every((check) => check.status === "pending")).toBe(true);
    expect(assessed.metrics.bootTimeMs.state).toBe("unmeasured");
    expect(assessed.metrics.peakHeapBytes).toEqual({
      state: "unmeasured",
      reason: "The probe does not measure peak heap in the session facet.",
    });
    expect(assessed.metrics.peakHeapBytes).not.toHaveProperty("value");
  });

  it("rejects the measured 96 MiB profile and keeps missing calibration or identity pending", async () => {
    const { frozen } = await fixture();
    for (const budgetBytes of [134_217_728, 128_000_000]) {
      const evidence = resourceEvidence(frozen, "local-workerd", {
        label: CONFIGURED_LIMIT_CRITERION,
        configuredLimit: {
          configuredLimitBytes: 100_663_296,
          deltaMaxObservedBytes: 101_195_616,
          safetyMarginBytes: 8_388_608,
          budgetBytes,
          calibrationComplete: false,
          workloadCompleted: false,
          identityVerified: true,
        },
      });
      const assessed = verifyReleaseCriteria(frozen, measurement(frozen), "local-workerd", {
        evidence,
        expectedArtifactSha256: "c".repeat(64),
        expectedReleaseIdentitySha256: "b".repeat(64),
      });
      expect(assessed.resourceCriteria).toMatchObject({
        status: "rejected",
        configuredLimit: {
          status: "rejected",
          assessedBytes: 210_247_520,
          budgetFits: false,
          strictByteBound: false,
        },
      });
    }
    for (const missing of ["calibrationComplete", "identityVerified"] as const) {
      const evidence = resourceEvidence(frozen, "local-workerd");
      const configuredLimit = evidence.criterion.configuredLimit as Record<string, unknown>;
      delete configuredLimit[missing];
      const assessed = verifyReleaseCriteria(frozen, measurement(frozen), "local-workerd", {
        evidence,
        expectedArtifactSha256: "c".repeat(64),
        expectedReleaseIdentitySha256: "b".repeat(64),
      });
      expect(assessed.resourceCriteria).toMatchObject({
        status: "pending",
        configuredLimit: { status: "pending", [missing]: false },
      });
    }
  });

  it("uses the deployed policy label and distinguishes missing termination from verified OOM", async () => {
    const { frozen } = await fixture();
    const deployedRaw = { ...measurement(frozen), environment: "deployed" };
    const deployed = verifyReleaseCriteria(frozen, deployedRaw, "deployed", {
      evidence: resourceEvidence(frozen, "deployed"),
      expectedArtifactSha256: "c".repeat(64),
      expectedReleaseIdentitySha256: "b".repeat(64),
    });
    expect(deployed.resourceCriteria).toMatchObject({
      status: "passed",
      label: "platform policy compliance evidence",
      platformPolicyCompliance: { status: "passed", identityVerified: true },
    });
    expect(deployed.metrics.peakHeapBytes.state).toBe("unmeasured");

    const evidence = resourceEvidence(frozen, "local-workerd", {
      label: CONFIGURED_LIMIT_CRITERION,
      configuredLimit: {
        configuredLimitBytes: 64,
        deltaMaxObservedBytes: 4,
        safetyMarginBytes: 8,
        budgetBytes: 128,
        calibrationComplete: true,
        workloadCompleted: false,
        identityVerified: true,
      },
      termination: {
        waited: true,
        timedOut: false,
        identityVerified: true,
        allocationRequestVerified: true,
        stderr: "JavaScript heap out of memory",
      },
    });
    const unverifiedOom = verifyReleaseCriteria(frozen, measurement(frozen), "local-workerd", {
      evidence,
      expectedArtifactSha256: "c".repeat(64),
      expectedReleaseIdentitySha256: "b".repeat(64),
    });
    expect(unverifiedOom.resourceCriteria).toMatchObject({
      status: "pending",
      terminationClassification: "NO_VERIFIED_TERMINATION",
    });
    (evidence.criterion as Record<string, unknown>).termination = {
      exitCode: 1,
      waited: true,
      timedOut: false,
      identityVerified: true,
      allocationRequestVerified: true,
      stderr: "JavaScript heap out of memory",
    };
    const verifiedOom = verifyReleaseCriteria(frozen, measurement(frozen), "local-workerd", {
      evidence,
      expectedArtifactSha256: "c".repeat(64),
      expectedReleaseIdentitySha256: "b".repeat(64),
    });
    expect(verifiedOom.resourceCriteria).toMatchObject({
      status: "pending",
      terminationClassification: "V8_HEAP_OOM_PROCESS_TERMINATED",
    });
  });

  it("rejects qualifier evidence whose frozen artifact pin drifted", async () => {
    const { frozen } = await fixture();
    const evidence = resourceEvidence(frozen, "local-workerd");
    evidence.artifactSha256 = "e".repeat(64);
    expect(() =>
      verifyReleaseCriteria(frozen, measurement(frozen), "local-workerd", {
        evidence,
        expectedArtifactSha256: "c".repeat(64),
        expectedReleaseIdentitySha256: "b".repeat(64),
      }),
    ).toThrow("PIN_MISMATCH");
  });

  it("binds exact module and binary request bytes to local and deployed evidence", async () => {
    const { frozen } = await fixture();
    const local = measurement(frozen);
    expect(verifyMeasurement(frozen, local, "local-workerd").results).toHaveLength(2);
    const deployed = { ...local, environment: "deployed", runId: "independent-deployed-run" };
    expect(verifyMeasurement(frozen, deployed, "deployed").runId).toBe("independent-deployed-run");
    expect(() => verifyMeasurement(frozen, local, "deployed")).toThrow("ENVIRONMENT_MISMATCH");
    expect(frozen.requests[0]?.payload?.bytes).toBe(3);
  });

  it("requires explicit behavioral assertions even when the generic probe reported no errors", async () => {
    const { frozen } = await fixture();
    const raw = measurement(frozen);
    const row = raw.rows[1]!;
    row.response.result.ok = false;
    expect(() => verifyMeasurement(frozen, raw, "local-workerd")).toThrow("BEHAVIOR_FAILED");
    const missing = {
      ...raw,
      rows: [raw.rows[0], { ...row, response: { status: 200, result: {} } }],
    };
    expect(() => verifyMeasurement(frozen, missing, "local-workerd")).toThrow("BEHAVIOR_FAILED");
  });

  it("rejects changed inventory, HTTP failure, omitted requests and wrong payload hashes", async () => {
    const { frozen } = await fixture();
    const changed = measurement(frozen);
    changed.rows[1]!.inventory[0]!.sha256 = "0".repeat(64);
    expect(() => verifyMeasurement(frozen, changed, "local-workerd")).toThrow("INVENTORY_MISMATCH");
    const http = measurement(frozen);
    http.rows[1]!.response.status = 500;
    expect(() => verifyMeasurement(frozen, http, "local-workerd")).toThrow("HTTP_FAILED");
    const omitted = measurement(frozen);
    omitted.rows.pop();
    expect(() => verifyMeasurement(frozen, omitted, "local-workerd")).toThrow(
      "REQUEST_COUNT_MISMATCH",
    );
    const payload = measurement(frozen);
    payload.rows[0]!.request = {
      ...payload.rows[0]!.request,
      payload: { ...frozen.requests[0]!.payload!, sha256: "0".repeat(64) },
    };
    expect(() => verifyMeasurement(frozen, payload, "local-workerd")).toThrow("PAYLOAD_MISMATCH");
  });

  it("detects fixture mutation between environments and refuses host programs or escaped inputs", async () => {
    const { root, manifest, frozen } = await fixture();
    await NodeFSP.writeFile(NodePath.join(root, "assets.bin"), "changed");
    const changed = await freezeFixture(root);
    expect(() => assertFixtureUnchanged(frozen, changed)).toThrow("FIXTURE_CHANGED");
    await NodeFSP.writeFile(
      NodePath.join(root, "manifest.json"),
      JSON.stringify({ ...manifest, mode: "worker" }),
    );
    await expect(freezeFixture(root)).rejects.toThrow("REQUIRES_FACET");
    const externalRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "1072-external-input-"),
    );
    directories.push(externalRoot);
    const external = NodePath.join(externalRoot, "outside");
    await NodeFSP.writeFile(external, "unowned");
    await NodeFSP.symlink(external, NodePath.join(root, "input-link"));
    await NodeFSP.writeFile(
      NodePath.join(root, "manifest.json"),
      JSON.stringify({ ...manifest, modules: { "main.js": { path: "input-link", type: "js" } } }),
    );
    await expect(freezeFixture(root)).rejects.toThrow("PATH_ESCAPE");
  });
});
