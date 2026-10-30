import { describe, expect, it } from "vite-plus/test";
import { assessPublicQualifierBuiltinEvidence } from "./builtinEvidence.ts";
import { inspectNodeBuiltinCoverage } from "./nodeBuiltinGate/coverage.ts";
import { createNodeBuiltinReachabilityInventory } from "./nodeBuiltinGate/reachability.ts";
import { scanBuiltinSource } from "./nodeBuiltinGate/source.ts";

const artifactSha256 = "a".repeat(64);
const source = scanBuiltinSource({
  name: "release.js",
  source:
    "import os from 'node:os'; export function optionalPriority(){ return os.getPriority(); }",
});
const report = inspectNodeBuiltinCoverage({
  builtinModules: ["os"],
  requiredSpecifiers: source.requiredSpecifiers,
  installedSpecifiers: ["os"],
  requiredFunctions: source.requiredFunctions,
  functionCapabilities: [
    {
      specifier: "os",
      memberPath: ["getPriority"],
      status: "unsupported",
      evidence: "Public runtime throws a named unsupported error.",
      failure: { kind: "named-error", code: "NODE_OS_PRIORITY_UNSUPPORTED" },
    },
  ],
});
const inventory = createNodeBuiltinReachabilityInventory(report, [source]);

describe("public qualifier builtin evidence", () => {
  it("accepts static preparation locally and keeps missing deployed observation pending", () => {
    const evidence = { expectedArtifactSha256: artifactSha256, inventory };
    const local = assessPublicQualifierBuiltinEvidence(evidence, "local-workerd", "local-run");
    expect(local.check.status).toBe("passed");
    expect(local.assessment).toMatchObject({
      coverageStatus: "pending",
      openObligations: [{ state: "awaiting-coverage" }],
    });
    expect(
      assessPublicQualifierBuiltinEvidence(evidence, "deployed", "deployed-run").check.status,
    ).toBe("pending");
  });

  it("requires the completed qualification corpus to belong to this measurement run", () => {
    const evidence = {
      expectedArtifactSha256: artifactSha256,
      inventory,
      corpus: {
        schemaVersion: 1 as const,
        runs: [
          {
            kind: "release-qualification" as const,
            runId: "deployed-run",
            artifactSha256,
            completed: true,
            captureState: "complete" as const,
            evidenceSha256: "e".repeat(64),
            sources: [
              {
                module: source.name,
                sourceSha256: source.sha256,
                executedByteRanges: [
                  {
                    startOffset: 0,
                    endOffset: 1,
                    offsetUnit: "utf16-code-units" as const,
                    executionCount: 1,
                  },
                ],
                invokedSiteIds: [],
              },
            ],
          },
        ],
      },
    };
    const accepted = assessPublicQualifierBuiltinEvidence(evidence, "deployed", "deployed-run");
    expect(accepted.check.status).toBe("passed");
    expect(accepted.assessment.openObligations).toMatchObject([
      {
        failureCode: "NODE_OS_PRIORITY_UNSUPPORTED",
        state: "unreached",
      },
    ]);
    expect(() =>
      assessPublicQualifierBuiltinEvidence(evidence, "deployed", "different-run"),
    ).toThrow("RELEASE_BUILTIN_QUALIFICATION_RUN_MISMATCH");
  });
});
