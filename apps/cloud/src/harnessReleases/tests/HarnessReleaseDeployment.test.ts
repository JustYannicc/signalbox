import { describe, expect, it } from "vite-plus/test";
import { assetSha256 } from "../../assets/ChunkedAsset.ts";
import {
  openHarnessReleaseDeployment,
  openHarnessReleaseQualificationInputs,
  readHarnessReleaseDeployment,
} from "../HarnessReleaseDeployment.ts";

const artifact = {
  provider: "codex" as const,
  releaseId: "official",
  artifactHash: "a".repeat(64),
  artifactRef: `sha256:${"a".repeat(64)}`,
  sourceIdentity: "b".repeat(64),
  fixtureIdentity: "fixture",
  createdAt: "2026-10-30T00:00:00.000Z",
};
const proof = (environment: "local-workerd" | "deployed-do") => ({
  ...artifact,
  proofId: environment,
  environment,
  recordedAt: artifact.createdAt,
  checks: {
    unchangedSource: "passed",
    boot: "passed",
    toolTurn: "passed",
    resume: "passed",
    mcp: "passed",
    interrupt: "passed",
  } as const,
  metrics: {
    bootTimeMs: { state: "measured", value: 1 },
    moduleBytes: { state: "measured", value: 2 },
    peakHeapBytes: { state: "measured", value: 3 },
  } as const,
});
const deployment = () => ({
  schemaVersion: 1,
  purpose: "release",
  projectId: "project",
  ledger: [{ artifact: { ...artifact }, proofs: [proof("local-workerd"), proof("deployed-do")] }],
  assets: [
    {
      schemaVersion: 1,
      projectId: "project",
      artifactRef: artifact.artifactRef,
      sourceIdentity: artifact.sourceIdentity,
      files: {
        "manifest.json": {
          bytes: 1,
          sha256: artifact.artifactHash,
          chunks: [{ offset: 0, length: 1, path: "manifest.bin", sha256: artifact.artifactHash }],
        },
      },
    },
  ],
});
const unusedBinding = {
  fetch: async () => {
    throw new Error("Unexpected asset fetch");
  },
};

describe("embedded release catalog and ledger", () => {
  it("retains open qualification findings in the bundled ledger and refuses release promotion", () => {
    const finding = {
      schemaVersion: 1,
      status: "open",
      sources: [],
      missingBuiltins: ["cluster"],
      unknownBuiltinSpecifiers: [],
      importAmbiguities: [],
      calls: [
        {
          specifier: "os",
          memberPath: ["getPriority"],
          status: "unsupported",
          failure: { kind: "named-error", code: "ENOSYS" },
        },
      ],
      callAmbiguities: [],
    };
    const input = {
      ...deployment(),
      purpose: "qualification",
      releasable: false,
      ledger: [{ artifact: { ...artifact }, proofs: [], openFindings: [finding] }],
    };
    const opened = openHarnessReleaseQualificationInputs(input, unusedBinding, "project");
    expect(opened.releasable).toBe(false);
    expect(opened.ledger.getEligibility("codex", "official").status).toBe("pending");
    expect(opened.ledger.getOpenFindings("codex", "official")).toEqual([finding]);
    const changed = opened.ledger.getOpenFindings("codex", "official");
    Reflect.set(changed[0]!, "status", "cleared");
    expect(opened.ledger.getOpenFindings("codex", "official")[0]!.status).toBe("open");
    expect(() =>
      openHarnessReleaseDeployment(
        {
          ...input,
          purpose: "release",
          releasable: true,
          ledger: [{ ...input.ledger[0]!, proofs: [proof("local-workerd"), proof("deployed-do")] }],
        },
        unusedBinding,
        "project",
      ),
    ).toThrow("HARNESS_DEPLOYMENT_OPEN_FINDINGS");
  });
  it("keeps candidate qualification inputs out of the release selector", () => {
    const input = deployment();
    input.purpose = "qualification";
    input.ledger[0]!.proofs = [];
    const candidate = openHarnessReleaseQualificationInputs(input, unusedBinding, "project");
    expect(candidate.ledger.getEligibility("codex", "official").status).toBe("pending");
    expect(() => openHarnessReleaseDeployment(input, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_PURPOSE_MISMATCH",
    );
    expect(() =>
      openHarnessReleaseQualificationInputs(deployment(), unusedBinding, "project"),
    ).toThrow("HARNESS_DEPLOYMENT_PURPOSE_MISMATCH");
  });
  it("verifies the deployment metadata pin and keeps the selected ledger immutable", async () => {
    const input = deployment();
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    const pin = { path: "deployment.json", bytes: bytes.length, sha256: await assetSha256(bytes) };
    const binding = { fetch: async () => new Response(bytes.slice().buffer) };
    const opened = await readHarnessReleaseDeployment(binding, pin, "project");
    expect(opened.ledger.getEligibility("codex", "official").status).toBe("green");
    const returned = opened.ledger.getArtifact("codex", "official")!;
    expect(returned).toEqual(artifact);
    Reflect.set(returned, "fixtureIdentity", "mutated");
    input.ledger[0]!.artifact.fixtureIdentity = "changed";
    expect(opened.ledger.getArtifact("codex", "official")).toEqual(artifact);
    await expect(
      readHarnessReleaseDeployment(binding, { ...pin, sha256: "f".repeat(64) }, "project"),
    ).rejects.toThrow("CHUNKED_ASSET_PIN_MISMATCH");
    await expect(readHarnessReleaseDeployment(binding, pin, "another-project")).rejects.toThrow(
      "HARNESS_DEPLOYMENT_PROJECT_MISMATCH",
    );
  });

  it("refuses pending, rejected, foreign and duplicate proofs", () => {
    const missing = deployment();
    missing.ledger[0]!.proofs.pop();
    expect(() => openHarnessReleaseDeployment(missing, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_NOT_QUALIFIED",
    );
    const rejected = deployment();
    Reflect.set(rejected.ledger[0]!.proofs[1]!.checks, "toolTurn", "rejected");
    expect(() => openHarnessReleaseDeployment(rejected, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_NOT_QUALIFIED",
    );
    const foreign = deployment();
    foreign.ledger[0]!.proofs[0]!.artifactHash = "c".repeat(64);
    expect(() => openHarnessReleaseDeployment(foreign, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_PROOF_MISMATCH",
    );
    const duplicate = deployment();
    duplicate.ledger[0]!.proofs.push(proof("deployed-do"));
    expect(() => openHarnessReleaseDeployment(duplicate, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_PROOF_MISMATCH",
    );
  });

  it("requires a unique asset inventory for every embedded release", () => {
    const absent = deployment();
    absent.assets = [];
    expect(() => openHarnessReleaseDeployment(absent, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_ASSET_MISSING",
    );
    const foreign = deployment();
    foreign.assets[0]!.artifactRef = `sha256:${"c".repeat(64)}`;
    expect(() => openHarnessReleaseDeployment(foreign, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_ASSET_MISMATCH",
    );
    const duplicate = deployment();
    duplicate.assets.push(duplicate.assets[0]!);
    expect(() => openHarnessReleaseDeployment(duplicate, unusedBinding, "project")).toThrow(
      "HARNESS_DEPLOYMENT_ASSET_MISMATCH",
    );
  });
});
