import { describe, expect, it } from "@effect/vitest";
import {
  createReleaseReport,
  recordReleaseArtifact,
  recordReleaseCheck,
  assertReleaseIsPublishable,
  releaseChecks,
} from "./release-report.ts";
import { scanClaudeReleaseInventory } from "./release-inventory.ts";

const identity = {
  provider: "claude-code" as const,
  version: "2.1.302",
  platform: "linux-x64",
  binarySha256: "a".repeat(64),
  bunVersion: null,
};
const artifact = {
  manifest: "bundle/manifest.json",
  moduleMap: "bundle/module-map.json",
  sha256: "b".repeat(64),
  bytes: 42,
};

function greenReport() {
  const inventory = scanClaudeReleaseInventory({
    release: identity,
    binary: { bytes: 100, sha256: identity.binarySha256 },
    graph: { entry: 0, flags: 0, recordSize: 72 },
    modules: [{ index: 0, name: "/entry.js", key: "entry.js", loader: 1, bytes: 0, source: "" }],
    capabilities: { bunApis: {}, nodeBuiltins: {} },
  });
  let report = { ...recordReleaseArtifact(createReleaseReport(identity), artifact), inventory };
  for (const check of releaseChecks)
    report = {
      ...recordReleaseCheck(report, identity, check, {
        status: "pass",
        diagnostics: [],
        artifactSha256: artifact.sha256,
      }),
      inventory,
    };
  return report;
}

describe("release evidence", () => {
  it("publishes a fully green report and rejects stale inventory identities", () => {
    const report = greenReport();
    expect(() => assertReleaseIsPublishable(report)).not.toThrow();
    for (const inventory of [
      { ...report.inventory, binary: { ...report.inventory.binary, sha256: "c".repeat(64) } },
      { ...report.inventory, release: { ...report.inventory.release, bunVersion: "1.3.0" } },
    ])
      expect(() => assertReleaseIsPublishable({ ...report, inventory })).toThrow(
        "RELEASE_INVENTORY_IDENTITY_MISMATCH",
      );
  });

  it("requires fresh rebundle evidence after an artifact replacement", () => {
    const original = greenReport();
    const nextArtifact = { ...artifact, sha256: "c".repeat(64) };
    let report = recordReleaseArtifact(original, nextArtifact);
    expect(report.checks.rebundle.status).toBe("pending");
    for (const check of ["localWorkerd", "deployedDO", "updateProof"] as const)
      report = recordReleaseCheck(report, identity, check, {
        status: "pass",
        diagnostics: [],
        artifactSha256: nextArtifact.sha256,
      });
    expect(() => assertReleaseIsPublishable(report)).toThrow("RELEASE_NOT_GREEN: rebundle");
    expect(() =>
      recordReleaseCheck(report, identity, "rebundle", {
        status: "pass",
        diagnostics: [],
        artifactSha256: artifact.sha256,
      }),
    ).toThrow("RELEASE_EVIDENCE_ARTIFACT_MISMATCH");
    expect(() =>
      assertReleaseIsPublishable({
        ...report,
        checks: { ...report.checks, rebundle: original.checks.rebundle },
      }),
    ).toThrow("RELEASE_NOT_GREEN: rebundle");
    report = recordReleaseCheck(report, identity, "rebundle", {
      status: "pass",
      diagnostics: [],
      artifactSha256: nextArtifact.sha256,
    });
    expect(() => assertReleaseIsPublishable(report)).not.toThrow();
  });
  it("keeps missing runtime proof pending and rejects evidence for another candidate", () => {
    const report = recordReleaseArtifact(createReleaseReport(identity), artifact);
    expect(() => assertReleaseIsPublishable(report)).toThrow("RELEASE_NOT_GREEN");
    expect(() =>
      recordReleaseCheck(report, { ...identity, binarySha256: "c".repeat(64) }, "inventory", {
        status: "pass",
        diagnostics: [],
      }),
    ).toThrow("RELEASE_EVIDENCE_IDENTITY_MISMATCH");
    expect(() =>
      recordReleaseCheck(report, identity, "deployedDO", {
        status: "pass",
        diagnostics: [],
        artifactSha256: "d".repeat(64),
      }),
    ).toThrow("RELEASE_EVIDENCE_ARTIFACT_MISMATCH");
  });

  it("invalidates runtime proof when the same official release is rebundled", () => {
    const report = recordReleaseCheck(
      recordReleaseArtifact(createReleaseReport(identity), artifact),
      identity,
      "localWorkerd",
      { status: "pass", diagnostics: [], artifactSha256: artifact.sha256 },
    );
    expect(recordReleaseArtifact(report, artifact).checks.localWorkerd.status).toBe("pass");
    const changed = recordReleaseArtifact(report, { ...artifact, sha256: "c".repeat(64) });
    expect(changed.checks.localWorkerd.status).toBe("pending");
    expect(changed.checks.deployedDO.status).toBe("pending");
    expect(changed.checks.updateProof.status).toBe("pending");
  });
});
