import { describe, expect, it } from "@effect/vitest";
import {
  assessNodeBuiltinReachability,
  type NodeBuiltinReachabilityInventory,
} from "./reachability.ts";

const artifactSha256 = "a".repeat(64);
const sourceSha256 = "b".repeat(64);
const siteId = "c".repeat(64);

function inventory(
  overrides: Partial<NodeBuiltinReachabilityInventory["callSites"][number]> = {},
): NodeBuiltinReachabilityInventory {
  return {
    schemaVersion: 1,
    sourceFiles: [{ name: "release.js", bytes: 100, sha256: sourceSha256, sourceUtf16Length: 100 }],
    analysisOnlyCallSites: [],
    callSites: [
      {
        siteId,
        sourceSha256,
        module: "release.js",
        startOffset: 10,
        endOffset: 30,
        offsetUnit: "utf16-code-units",
        line: 1,
        column: 10,
        specifier: "os",
        memberPath: ["getPriority"],
        status: "unsupported",
        evidence: "runtime does not implement this function",
        failure: { kind: "named-error", code: "NODE_OS_PRIORITY_UNSUPPORTED" },
        ...overrides,
      },
    ],
    missingBuiltins: [],
    unknownBuiltinSpecifiers: [],
    ambiguities: [],
    functionAmbiguities: [],
  };
}

function run(
  kind: "a-series-replay" | "release-qualification",
  sources: BuiltinRun["sources"],
  overrides: Partial<BuiltinRun> = {},
): BuiltinRun {
  return {
    kind,
    runId: `${kind}-1`,
    artifactSha256,
    completed: true,
    captureState: "complete",
    evidenceSha256: "e".repeat(64),
    sources,
    ...overrides,
  };
}

type BuiltinRun = {
  readonly kind: "a-series-replay" | "release-qualification";
  readonly runId: string;
  readonly artifactSha256: string;
  readonly completed: boolean;
  readonly captureState: "complete" | "incomplete" | "not-started";
  readonly evidenceSha256: string;
  readonly sources: readonly {
    readonly module: string;
    readonly sourceSha256: string;
    readonly executedByteRanges: readonly {
      readonly startOffset: number;
      readonly endOffset: number;
      readonly offsetUnit: "utf16-code-units";
      readonly executionCount: number;
    }[];
    readonly invokedSiteIds: readonly string[];
  }[];
};

const source = (
  executedByteRanges: BuiltinRun["sources"][number]["executedByteRanges"],
  invokedSiteIds: readonly string[] = [],
) => [{ module: "release.js", sourceSha256, executedByteRanges, invokedSiteIds }];

const range = (startOffset: number, endOffset: number, executionCount = 1) => ({
  startOffset,
  endOffset,
  offsetUnit: "utf16-code-units" as const,
  executionCount,
});

const evidence = (...runs: BuiltinRun[]) => ({ schemaVersion: 1 as const, runs });

describe("builtin release reachability", () => {
  it("keeps missing corpus pending and does not call obligations unreached", () => {
    const report = assessNodeBuiltinReachability({ artifactSha256, inventory: inventory() });
    expect(report).toMatchObject({
      coverageStatus: "pending",
      openObligations: [{ siteId, state: "awaiting-coverage" }],
    });
  });

  it("records capture-not-started as unavailable observation, never unreached", () => {
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: inventory(),
      corpus: evidence(
        run("a-series-replay", source([]), { captureState: "not-started", completed: false }),
      ),
    });
    expect(report).toMatchObject({
      coverageStatus: "pending",
      openObligations: [{ state: "awaiting-coverage" }],
      excludedRuns: [{ reason: expect.stringContaining("capture did not start") }],
      evidence: {
        corpus: { runs: [{ captureState: "not-started", evidenceSha256: "e".repeat(64) }] },
      },
    });
  });

  it("does not infer unreached sites from a complete flag with no execution evidence", () => {
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: inventory(),
      corpus: evidence(run("release-qualification", source([]))),
    });
    expect(report).toMatchObject({
      coverageStatus: "rejected",
      openObligations: [{ state: "awaiting-coverage" }],
      blockers: [expect.stringContaining("has no executed evidence")],
    });
  });

  it("rejects unsupported calls whose exact source span overlaps a positive V8 range", () => {
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: inventory(),
      corpus: evidence(run("release-qualification", source([range(25, 35)]))),
    });
    expect(report).toMatchObject({
      coverageStatus: "rejected",
      reachedSites: [
        { siteId, method: "reached by executed range", runId: "release-qualification-1" },
      ],
      blockers: [expect.stringContaining("reached unsupported builtin os.getPriority")],
      observation: {
        limitation: expect.stringContaining("does not prove the builtin call succeeded"),
      },
    });
  });

  it("keeps unobserved unsupported sites as open obligations after a complete release workload", () => {
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: inventory(),
      corpus: evidence(run("release-qualification", source([range(0, 5)]))),
    });
    expect(report).toMatchObject({
      coverageStatus: "passed",
      openObligations: [
        { siteId, state: "unreached", failureCode: "NODE_OS_PRIORITY_UNSUPPORTED" },
      ],
    });
  });

  it("requires an invocation id to point to a scanned callsite", () => {
    expect(() =>
      assessNodeBuiltinReachability({
        artifactSha256,
        inventory: inventory(),
        corpus: evidence(run("release-qualification", source([], ["d".repeat(64)]))),
      }),
    ).toThrow("NODE_BUILTIN_REACHABILITY_EVIDENCE_INVALID");
  });

  it("rejects historical captured evidence without its original source inventory", () => {
    expect(() =>
      assessNodeBuiltinReachability({
        artifactSha256,
        inventory: inventory(),
        corpus: evidence(
          run("a-series-replay", source([range(10, 30)]), { artifactSha256: "d".repeat(64) }),
        ),
      }),
    ).toThrow("NODE_BUILTIN_REACHABILITY_EVIDENCE_INVALID");
  });

  it("rejects zero-count or differently measured ranges", () => {
    for (const invalidRange of [range(10, 30, 0), { ...range(10, 30), offsetUnit: "bytes" }]) {
      expect(() =>
        assessNodeBuiltinReachability({
          artifactSha256,
          inventory: inventory(),
          corpus: evidence(run("release-qualification", source([invalidRange as never]))),
        }),
      ).toThrow("NODE_BUILTIN_REACHABILITY_EVIDENCE_INVALID");
    }
  });

  it("keeps unknown computed calls blocking even when the workload has no matching ranges", () => {
    const report = assessNodeBuiltinReachability({
      artifactSha256,
      inventory: {
        ...inventory(),
        functionAmbiguities: [
          {
            kind: "dynamic-builtin-member-call",
            module: "release.js",
            line: 2,
            column: 5,
            specifier: "os.<computed>",
            severity: "error",
          },
        ],
      },
      corpus: evidence(run("release-qualification", source([range(0, 5)]))),
    });
    expect(report.coverageStatus).toBe("rejected");
  });
});
