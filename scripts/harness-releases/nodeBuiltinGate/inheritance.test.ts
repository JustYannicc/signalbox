import { describe, expect, it } from "@effect/vitest";
import { isHarnessReleaseBuiltinCriteriaAssessment } from "@t3tools/shared/harnessReleaseBuiltinCriteria";
import {
  assessNodeBuiltinReachability,
  type NodeBuiltinReachabilityInventory,
} from "./reachability.ts";

const artifactSha256 = "a".repeat(64);
const originalArtifact = "b".repeat(64);
const sourceHash = "c".repeat(64);
const siteId = "d".repeat(64);
const originalSiteId = "e".repeat(64);
const evidenceSha256 = "f".repeat(64);
const currentInventory = (): NodeBuiltinReachabilityInventory => ({
  schemaVersion: 1,
  sourceFiles: [{ name: "current.js", bytes: 100, sha256: sourceHash, sourceUtf16Length: 100 }],
  callSites: [
    {
      siteId,
      sourceSha256: sourceHash,
      module: "current.js",
      startOffset: 20,
      endOffset: 40,
      offsetUnit: "utf16-code-units",
      line: 1,
      column: 21,
      specifier: "node:os",
      memberPath: ["getPriority"],
      status: "supported",
      evidence: "runtime implementation",
    },
  ],
  analysisOnlyCallSites: [],
  missingBuiltins: [],
  unknownBuiltinSpecifiers: [],
  ambiguities: [],
  functionAmbiguities: [],
});
const originalInventory = (): NodeBuiltinReachabilityInventory => ({
  ...currentInventory(),
  sourceFiles: [
    { name: "original.js", bytes: 200, sha256: originalArtifact, sourceUtf16Length: 200 },
  ],
  callSites: [
    {
      ...currentInventory().callSites[0]!,
      siteId: originalSiteId,
      sourceSha256: originalArtifact,
      module: "original.js",
      startOffset: 100,
      endOffset: 140,
      specifier: "os",
    },
  ],
});
const range = (startOffset: number, endOffset: number) => ({
  startOffset,
  endOffset,
  offsetUnit: "utf16-code-units" as const,
  executionCount: 1,
});
const corpus = () => ({
  schemaVersion: 1 as const,
  inheritedArtifacts: [
    { release: "303", artifactSha256: originalArtifact, inventory: originalInventory() },
  ],
  runs: [
    {
      kind: "a-series-replay" as const,
      runId: "A34",
      artifactSha256: originalArtifact,
      completed: false,
      captureState: "incomplete" as const,
      evidenceSha256,
      sources: [
        {
          module: "original.js",
          sourceSha256: originalArtifact,
          executedByteRanges: [range(110, 120)],
          invokedSiteIds: [] as string[],
        },
      ],
    },
    {
      kind: "release-qualification" as const,
      runId: "qualification-312",
      artifactSha256,
      completed: true,
      captureState: "complete" as const,
      evidenceSha256,
      sources: [
        {
          module: "current.js",
          sourceSha256: sourceHash,
          executedByteRanges: [range(0, 5)],
          invokedSiteIds: [] as string[],
        },
      ],
    },
  ],
});
const expected = {
  environment: "deployed" as const,
  artifactSha256,
  measurementRunId: "qualification-312",
};

describe("inherited real-session builtin reachability", () => {
  it("retains exact original provenance even when direct qualification does not reach the API", () => {
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: currentInventory(),
      corpus: corpus(),
    });
    expect(report.coverageStatus).toBe("passed");
    expect(report.reachedSites).toMatchObject([
      {
        siteId,
        inheritedFrom: [
          {
            release: "303",
            runId: "A34",
            artifactSha256: originalArtifact,
            evidenceSha256,
            module: "original.js",
            sourceSha256: originalArtifact,
            siteId: originalSiteId,
            method: "reached by executed range",
            label: "reached (inherited from 303/A34)",
          },
        ],
      },
    ]);
    expect(isHarnessReleaseBuiltinCriteriaAssessment(report, expected)).toBe(true);

    const erased = { ...report, reachedSites: [] };
    expect(isHarnessReleaseBuiltinCriteriaAssessment(erased, expected)).toBe(false);
    expect(
      isHarnessReleaseBuiltinCriteriaAssessment(
        {
          ...report,
          reachedSites: report.reachedSites.map(({ inheritedFrom: _omit, ...site }) => site),
        },
        expected,
      ),
    ).toBe(false);
  });

  it.each([
    "unsupported",
    "missing",
    "conditional",
    "unknown",
    "platform-pruned",
    "guarded",
  ] as const)("blocks an inherited reached API now classified %s", (status) => {
    const inventory = currentInventory();
    const site = {
      ...inventory.callSites[0]!,
      status,
      ...(status === "unsupported"
        ? { failure: { kind: "named-error" as const, code: "NODE_OS_PRIORITY_UNSUPPORTED" } }
        : {}),
    };
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: { ...inventory, callSites: [site] },
      corpus: corpus(),
    });
    expect(report.coverageStatus).toBe("rejected");
    expect(report.blockers).toContainEqual(expect.stringContaining(`reached ${status} builtin`));
    expect(report.openObligations.every((obligation) => obligation.state !== "unreached")).toBe(
      true,
    );
    expect(
      isHarnessReleaseBuiltinCriteriaAssessment(
        { ...report, coverageStatus: "passed", blockers: [], reachedSites: [] },
        expected,
      ),
    ).toBe(false);
  });

  it("adds direct invocation evidence without erasing the inherited observation", () => {
    const capture = corpus();
    capture.runs[1]!.sources[0]!.invokedSiteIds.push(siteId);
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: currentInventory(),
      corpus: capture,
    });
    expect(report.reachedSites).toMatchObject([
      {
        method: "observed invocation",
        runId: "qualification-312",
        inheritedFrom: [{ runId: "A34", module: "original.js" }],
      },
    ]);
    expect(isHarnessReleaseBuiltinCriteriaAssessment(report, expected)).toBe(true);
  });

  it("records an API path disappearing from the candidate", () => {
    const inventory = currentInventory();
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: { ...inventory, callSites: [] },
      corpus: corpus(),
    });
    expect(report).toMatchObject({
      coverageStatus: "passed",
      reachedSites: [],
      removedApiPaths: [
        { specifier: "os", memberPath: ["getPriority"], inheritedFrom: [{ runId: "A34" }] },
      ],
    });
    expect(isHarnessReleaseBuiltinCriteriaAssessment(report, expected)).toBe(true);
    expect(
      isHarnessReleaseBuiltinCriteriaAssessment({ ...report, removedApiPaths: [] }, expected),
    ).toBe(false);
  });

  it("applies inherited reachability to linked analysis sites too", () => {
    const inventory = currentInventory();
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: {
        ...inventory,
        callSites: [],
        analysisOnlyCallSites: [{ ...inventory.callSites[0]!, status: "unknown" }],
      },
      corpus: corpus(),
    });
    expect(report.coverageStatus).toBe("rejected");
    expect(report.reachedSites).toMatchObject([
      { siteId, status: "unknown", inheritedFrom: [{ runId: "A34" }] },
    ]);
    expect(report.removedApiPaths).toEqual([]);
  });

  it("keeps a supported linked API present without inventing runtime range coverage", () => {
    const inventory = currentInventory();
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: { ...inventory, callSites: [], analysisOnlyCallSites: inventory.callSites },
      corpus: corpus(),
    });
    expect(report).toMatchObject({
      coverageStatus: "passed",
      removedApiPaths: [],
      unmappedAnalysisSites: [],
      reachedSites: [{ siteId, inheritedFrom: [{ runId: "A34" }] }],
    });
    expect(isHarnessReleaseBuiltinCriteriaAssessment(report, expected)).toBe(true);
  });

  it("fails closed without original inventory or matching original source hashes", () => {
    const capture = corpus();
    for (const evidence of [
      { ...capture, inheritedArtifacts: [] },
      {
        ...capture,
        runs: capture.runs.map((run, index) =>
          index ? run : { ...run, sources: [{ ...run.sources[0]!, sourceSha256: sourceHash }] },
        ),
      },
    ]) {
      expect(() =>
        assessNodeBuiltinReachability({
          artifactSha256,
          inventory: currentInventory(),
          corpus: evidence,
        }),
      ).toThrow("NODE_BUILTIN_REACHABILITY_EVIDENCE_INVALID");
    }
  });

  it("keeps A33 without started capture unavailable and requires no historical inventory", () => {
    const capture = corpus();
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: currentInventory(),
      corpus: {
        schemaVersion: 1,
        runs: [
          { ...capture.runs[0], runId: "A33", captureState: "not-started", sources: [] },
          capture.runs[1],
        ],
      },
    });
    expect(report.reachedSites).toEqual([]);
    expect(report.excludedRuns).toMatchObject([
      { runId: "A33", reason: expect.stringContaining("capture did not start") },
    ]);
    expect(isHarnessReleaseBuiltinCriteriaAssessment(report, expected)).toBe(true);
  });
});
