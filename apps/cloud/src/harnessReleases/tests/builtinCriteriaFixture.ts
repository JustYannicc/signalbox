export const builtinCriteriaFixture = (environment: string, artifactSha256: string) => {
  const sourceSha256 = "d".repeat(64);
  const siteId = "e".repeat(64);
  const deployed = environment === "deployed";
  return {
    schemaVersion: 1,
    artifactSha256,
    coverageStatus: deployed ? "passed" : "pending",
    ...(deployed ? { qualifiedRunId: "deployed-proof-run" } : {}),
    observation: {
      method: "reached by executed range",
      limitation: "Control-flow reachability only, without invocation success or counts.",
    },
    evidence: {
      inventory: {
        schemaVersion: 1,
        sourceFiles: [
          { name: "release.js", bytes: 100, sha256: sourceSha256, sourceUtf16Length: 100 },
        ],
        callSites: [
          {
            siteId,
            sourceSha256,
            module: "release.js",
            startOffset: 10,
            endOffset: 30,
            offsetUnit: "utf16-code-units",
            line: 1,
            column: 11,
            specifier: "os",
            memberPath: ["platform"],
            status: "supported",
            evidence: "Runtime implementation.",
          },
        ],
        analysisOnlyCallSites: [],
        missingBuiltins: [],
        unknownBuiltinSpecifiers: [],
        ambiguities: [],
        functionAmbiguities: [],
      },
      corpus: {
        schemaVersion: 1,
        runs: deployed
          ? [
              {
                kind: "release-qualification",
                runId: "deployed-proof-run",
                artifactSha256,
                completed: true,
                captureState: "complete",
                evidenceSha256: "f".repeat(64),
                sources: [
                  {
                    module: "release.js",
                    sourceSha256,
                    invokedSiteIds: [siteId],
                    executedByteRanges: [],
                  },
                ],
              },
            ]
          : [],
      },
    },
    reachedSites: deployed
      ? [
          {
            siteId,
            module: "release.js",
            specifier: "os",
            memberPath: ["platform"],
            status: "supported",
            method: "observed invocation",
            runId: "deployed-proof-run",
          },
        ]
      : [],
    removedApiPaths: [],
    unmappedAnalysisSites: [],
    blockers: [],
    openObligations: [],
    excludedRuns: [],
  };
};
