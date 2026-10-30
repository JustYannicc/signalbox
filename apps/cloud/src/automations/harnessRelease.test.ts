import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { BUILT_IN_AUTOMATIONS } from "@signalbox/automations/defaults/registry";
import { HARNESS_RELEASE_WATCH } from "@signalbox/automations/defaults/harnessRelease";
import { HARNESS_RELEASE_DISCOVERY_SOURCE } from "@signalbox/automations/defaults/harnessReleaseDiscoverySource";
import { HARNESS_RELEASE_EXECUTION_SOURCE } from "@signalbox/automations/defaults/harnessReleaseExecutionSource";
import { HARNESS_RELEASE_POLICY_SOURCE } from "@signalbox/automations/defaults/harnessReleasePolicySource";
import {
  canPromoteHarnessRelease,
  isVerifiedHarnessRelease,
  ledgerProviderFor,
  nextHarnessReleaseBatch,
  orderReleaseCandidates,
  releaseReceiptKey,
  releaseReceiptDisposition,
  releaseRunKey,
  summarizeHarnessBackfill,
  shouldReuseReleaseReceipt,
  type HarnessReleaseCandidate,
} from "@signalbox/automations/defaults/harnessReleasePolicy";
import { describe, expect, it } from "@effect/vitest";

const candidate = (
  provider: HarnessReleaseCandidate["provider"],
  version: string,
  selection: HarnessReleaseCandidate["selection"],
): HarnessReleaseCandidate => ({
  id: `${provider}:${version}`,
  provider,
  version,
  upstreamIdentity: `${provider}:${version}`,
  selection,
});

const criteria = [
  "boot",
  "text",
  "readEdit",
  "bash",
  "grep",
  "resume",
  "mcp",
  "interrupt",
  "publicHarness",
  "builtinCoverage",
];

type TestMetric = { state: "measured"; value: number } | { state: "unmeasured"; reason: string };
type TestResult = {
  provider?: string;
  status: string;
  unchangedSource: string;
  artifact?: { sha256: string };
  fixture?: { id: string; sha256: string };
  identity?: { sha256: string };
  environments: Record<
    string,
    {
      checks: Array<{ name: string; status: string }>;
      measurementRunId?: string;
      metrics: Record<string, TestMetric>;
      resourceCriteria?: unknown;
      deployedResourceContext?: typeof deployedResourceContext;
      builtinCriteria?: unknown;
    }
  >;
};

const greenResult = (): TestResult => ({
  provider: "codex",
  status: "green",
  unchangedSource: "passed",
  artifact: { sha256: "a".repeat(64) },
  environments: Object.fromEntries(
    ["local-workerd", "deployed"].map((environment) => [
      environment,
      {
        checks: criteria.map((name) => ({ name, status: "passed" })),
        measurementRunId: `${environment}-proof-run`,
        builtinCriteria: builtinVerdict(environment),
        metrics: {
          moduleBytes: { state: "measured", value: 1 },
          bootTimeMs: { state: "measured", value: 1 },
          peakHeapBytes: { state: "measured", value: 1 },
        },
      },
    ]),
  ) as TestResult["environments"],
});

const builtinVerdict = (environment: string) => {
  const artifactSha256 = "a".repeat(64);
  const sourceSha256 = "d".repeat(64);
  const siteId = "c".repeat(64);
  return {
    schemaVersion: 1,
    artifactSha256,
    coverageStatus: environment === "deployed" ? "passed" : "pending",
    ...(environment === "deployed" ? { qualifiedRunId: "deployed-proof-run" } : {}),
    observation: {
      method: "reached by executed range",
      limitation: "Control-flow reachability only, without call success or invocation counts.",
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
            memberPath: ["getPriority"],
            status: "unsupported",
            evidence: "Throws the named unsupported error.",
            failure: { kind: "named-error", code: "NODE_OS_PRIORITY_UNSUPPORTED" },
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
        runs:
          environment === "local-workerd"
            ? []
            : [
                {
                  kind: "release-qualification",
                  runId: "deployed-proof-run",
                  artifactSha256,
                  completed: true,
                  captureState: "complete",
                  evidenceSha256: "e".repeat(64),
                  sources: [
                    {
                      module: "release.js",
                      sourceSha256,
                      invokedSiteIds: [],
                      executedByteRanges: [
                        {
                          startOffset: 40,
                          endOffset: 50,
                          offsetUnit: "utf16-code-units",
                          executionCount: 1,
                        },
                      ],
                    },
                  ],
                },
              ],
      },
    },
    blockers: [],
    reachedSites: [],
    unmappedAnalysisSites: [],
    excludedRuns: [],
    openObligations: [
      {
        kind: "unsupported-fail-loud",
        siteId,
        module: "release.js",
        specifier: "os",
        memberPath: ["getPriority"],
        failureCode: "NODE_OS_PRIORITY_UNSUPPORTED",
        state: environment === "deployed" ? "unreached" : "awaiting-coverage",
      },
    ],
  };
};

const deployedResourceContext = {
  deploymentId: "deploy-3",
  loaderId: "claude-loader",
  facetId: "qualification-facet",
  responsePlanSha256: "e".repeat(64),
  expectedResponses: [
    { id: "run-1", method: "run" },
    { id: "dispose-1", method: "dispose" },
  ],
};

const taggedResourceCriteria = (environment: "local-workerd" | "deployed") => ({
  tag: "harness-release-resource-criteria-v2",
  source: "normal-public-qualifier",
  environment,
  status: environment === "local-workerd" ? "not-applicable" : "passed",
  label: "platform policy compliance evidence",
  pins: {
    measurementRunId: `${environment}-proof-run`,
    fixtureId: "fixture-1",
    fixtureSha256: "f".repeat(64),
    artifactSha256: "a".repeat(64),
    releaseIdentitySha256: "b".repeat(64),
  },
  startupUpperBound: {
    label: "cold first-successful-RPC latency",
    interpretation: "startup upper bound",
    clock: "parent process.hrtime.bigint",
    startedMonotonicNs: "100",
    finishedMonotonicNs: "200",
    milliseconds: 0.0001,
    includesRpc: true,
    exactBootTime: false,
  },
  ...(environment === "deployed"
    ? {
        platformPolicyCompliance: {
          label: "platform policy compliance evidence",
          status: "passed",
          identityVerified: true,
          collectorRecord: {
            measurementRunId: "deployed-proof-run",
            deploymentId: deployedResourceContext.deploymentId,
            loaderId: deployedResourceContext.loaderId,
            facetId: deployedResourceContext.facetId,
            selectedReleaseSha256: "a".repeat(64),
            responsePlanSha256: deployedResourceContext.responsePlanSha256,
            workloadCompleted: true,
            beforeProbe: { status: 200, isolateNonce: "isolate-A" },
            responses: deployedResourceContext.expectedResponses.map((response) => ({
              ...response,
              status: 200,
              isolateNonce: "isolate-A",
            })),
            afterProbe: { status: 200, isolateNonce: "isolate-A" },
          },
        },
      }
    : {}),
  detail: "Resource evidence passed.",
});

const greenTaggedResourceResult = () => {
  const result = greenResult();
  result.provider = "claude-code";
  result.artifact = { sha256: "a".repeat(64) };
  result.fixture = { id: "fixture-1", sha256: "f".repeat(64) };
  result.identity = { sha256: "b".repeat(64) };
  for (const environment of ["local-workerd", "deployed"] as const) {
    result.environments[environment]!.metrics.bootTimeMs = {
      state: "unmeasured",
      reason: "The startup upper bound includes the first RPC.",
    };
    result.environments[environment]!.metrics.peakHeapBytes = {
      state: "unmeasured",
      reason: "The resource criterion does not measure peak heap.",
    };
    result.environments[environment]!.resourceCriteria = taggedResourceCriteria(environment);
  }
  result.environments.deployed!.deployedResourceContext = deployedResourceContext;
  return result;
};

describe("harness release watcher", () => {
  it("compiles as an hourly project-only built-in", () => {
    const builtIn = BUILT_IN_AUTOMATIONS.find((entry) => entry.slug === "harness-release-watch");
    expect(builtIn?.source).toBe(HARNESS_RELEASE_WATCH);
    expect(builtIn?.defaultOn).toBeUndefined();

    const compiled = compileWorkflow(HARNESS_RELEASE_WATCH);
    expect(compiled.ok).toBe(true);
    expect(HARNESS_RELEASE_WATCH).toContain('cron: "0 * * * *"');
    expect(HARNESS_RELEASE_WATCH).toContain('timezone: "Europe/Zurich"');
  });

  it("runs current releases first and only a small backfill slice each hour", () => {
    const releases = [
      candidate("codex", "0.4.0", "current"),
      candidate("claude-agent-sdk", "0.4.0", "current"),
      candidate("claude-code", "2.1.303", "current"),
      ...Array.from({ length: 51 }, (_, index) =>
        candidate("claude-code", `2.0.${50 - index}`, "backfill"),
      ),
      ...Array.from({ length: 11 }, (_, index) =>
        candidate("codex", `0.3.${10 - index}`, "backfill"),
      ),
      candidate("claude-agent-sdk", "0.3.0", "backfill"),
    ];

    const selected = orderReleaseCandidates(releases);
    expect(selected.filter((release) => release.selection === "current")).toHaveLength(3);
    expect(selected.filter((release) => release.provider === "claude-code")).toHaveLength(51);
    expect(selected.filter((release) => release.provider === "codex")).toHaveLength(11);
    expect(selected.filter((release) => release.provider === "claude-agent-sdk")).toHaveLength(1);

    const blocked = nextHarnessReleaseBatch(releases);
    expect(blocked.map((release) => release.selection)).toEqual(["current", "current", "current"]);

    const batch = nextHarnessReleaseBatch(releases, ["claude-code", "claude-agent-sdk"]);
    expect(batch.map((release) => release.selection)).toEqual(["current", "current", "current"]);

    const ready = nextHarnessReleaseBatch(releases, ["claude-code", "claude-agent-sdk", "codex"]);
    expect(ready.slice(0, 3).every((release) => release.selection === "current")).toBe(true);
    expect(
      ready
        .filter((release) => release.selection === "backfill")
        .map((release) => release.provider),
    ).toEqual(["claude-code", "codex"]);
    const firstClaudeBackfill = ready.find(
      (release) => release.selection === "backfill" && release.provider === "claude-code",
    );
    expect(firstClaudeBackfill).toBeDefined();
    const afterClaude = nextHarnessReleaseBatch(
      releases,
      ["claude-code", "claude-agent-sdk", "codex"],
      [firstClaudeBackfill!.id],
    );
    expect(
      afterClaude.find(
        (release) => release.provider === "claude-code" && release.selection === "backfill",
      )?.id,
    ).not.toBe(firstClaudeBackfill!.id);
  });

  it("counts the bounded historical set against the 90 percent proof target", () => {
    const releases = [
      candidate("codex", "1.0.0", "current"),
      ...Array.from({ length: 10 }, (_, index) =>
        candidate("codex", `0.9.${9 - index}`, "backfill"),
      ),
    ];
    const history = orderReleaseCandidates(releases).filter(
      (release) => release.selection === "backfill",
    );
    const receipts = history.map((release, index) => ({
      discoveryId: release.id,
      runKey: releaseRunKey(release.provider, release.version),
      headSha: "source-head",
      workflowStatus: "completed",
      proofStatus: index === 9 ? "red" : "green",
      proofArtifactVerified: true,
    }));
    expect(summarizeHarnessBackfill(releases, receipts, "source-head")).toMatchObject({
      total: 10,
      terminal: 10,
      green: 9,
      red: 1,
      acceptance: "met",
    });
    expect(summarizeHarnessBackfill(releases, receipts, "another-head").acceptance).toBe(
      "in-progress",
    );
  });

  it("reopens incomplete receipts against the same run and reuses only verified terminal results", () => {
    const runKey = releaseRunKey("claude-code", "2.1.303");
    expect(runKey).toBe("harness-release:claude-code:2.1.303");
    expect(releaseReceiptKey("claude-code", "2.1.303", "abc123")).toBe(`${runKey}:abc123`);
    expect(
      shouldReuseReleaseReceipt(
        {
          runKey,
          headSha: "abc123",
          status: "pending",
          workflowStatus: "in_progress",
          proofArtifactVerified: false,
        },
        runKey,
        "abc123",
      ),
    ).toBe(false);
    expect(
      releaseReceiptDisposition(
        {
          runKey,
          headSha: "abc123",
          status: "pending",
          workflowStatus: "in_progress",
          workflowRunId: "42",
        },
        runKey,
        "abc123",
      ),
    ).toBe("read");
    expect(
      releaseReceiptDisposition(
        {
          runKey,
          headSha: "abc123",
          status: "pending",
        },
        runKey,
        "abc123",
      ),
    ).toBe("dispatch");
    expect(
      releaseReceiptDisposition(
        {
          runKey,
          headSha: "abc123",
          status: "pending",
          workflowStatus: "completed",
          proofArtifactVerified: true,
        },
        runKey,
        "abc123",
      ),
    ).toBe("reuse");
    expect(
      shouldReuseReleaseReceipt(
        {
          runKey,
          headSha: "abc123",
          status: "green",
          ledgerStatus: "recorded",
          workflowStatus: "completed",
          proofArtifactVerified: false,
          runtimeArtifactVerified: true,
        },
        runKey,
        "abc123",
      ),
    ).toBe(false);
    expect(
      shouldReuseReleaseReceipt(
        {
          runKey,
          headSha: "abc123",
          status: "green",
          ledgerStatus: "recorded",
          workflowStatus: "completed",
          proofArtifactVerified: true,
          runtimeArtifactVerified: true,
        },
        runKey,
        "abc123",
      ),
    ).toBe(true);
    expect(
      shouldReuseReleaseReceipt(
        {
          runKey,
          headSha: "abc123",
          status: "green",
          ledgerStatus: "recorded",
          workflowStatus: "completed",
          proofArtifactVerified: true,
          runtimeArtifactVerified: false,
        },
        runKey,
        "abc123",
      ),
    ).toBe(false);
    expect(
      shouldReuseReleaseReceipt({ runKey, headSha: "abc123", status: "red" }, runKey, "def456"),
    ).toBe(false);
    expect(ledgerProviderFor("claude-agent-sdk")).toBe("agent-sdk");
  });

  it("promotes only a current release with all public proof and captured revision", () => {
    const result = greenResult();
    expect(isVerifiedHarnessRelease("green", result)).toBe(true);
    expect(
      canPromoteHarnessRelease({
        selection: "current",
        status: "green",
        runtimeArtifactVerified: true,
        expectedRevision: 3,
        currentRevision: 3,
        result,
      }),
    ).toBe(true);
    expect(
      canPromoteHarnessRelease({
        selection: "backfill",
        status: "green",
        runtimeArtifactVerified: true,
        expectedRevision: 3,
        currentRevision: 3,
        result,
      }),
    ).toBe(false);
    expect(
      canPromoteHarnessRelease({
        selection: "current",
        status: "green",
        runtimeArtifactVerified: false,
        expectedRevision: 3,
        currentRevision: 3,
        result,
      }),
    ).toBe(false);
    expect(
      canPromoteHarnessRelease({
        selection: "current",
        status: "green",
        runtimeArtifactVerified: true,
        expectedRevision: 3,
        currentRevision: 4,
        result,
      }),
    ).toBe(false);
    const missingPeak = structuredClone(result);
    missingPeak.environments["deployed"]!.metrics.peakHeapBytes = {
      state: "unmeasured",
      reason: "not measured",
    };
    expect(isVerifiedHarnessRelease("green", missingPeak)).toBe(false);
    const partialChecks = structuredClone(result);
    partialChecks.environments["local-workerd"]!.checks[0]!.status = "pending";
    expect(isVerifiedHarnessRelease("green", partialChecks)).toBe(false);
  });

  it("accepts tagged startup upper bounds only when peak heap stays unmeasured", () => {
    const result = greenTaggedResourceResult();
    expect(isVerifiedHarnessRelease("green", result)).toBe(true);
    for (const environment of ["local-workerd", "deployed"] as const) {
      const assessment = result.environments[environment]!;
      expect(assessment.metrics.bootTimeMs!.state).toBe("unmeasured");
      expect(assessment.metrics.peakHeapBytes!.state).toBe("unmeasured");
      expect(assessment.resourceCriteria).toMatchObject({
        startupUpperBound: {
          label: "cold first-successful-RPC latency",
          interpretation: "startup upper bound",
          includesRpc: true,
          exactBootTime: false,
        },
      });
    }
  });

  it("refuses nonce changes, incomplete plans and retired local memory claims", () => {
    const changed = greenTaggedResourceResult();
    const deployed = taggedResourceCriteria("deployed");
    if (!deployed.platformPolicyCompliance) throw new Error("Deployed policy missing");
    deployed.platformPolicyCompliance.collectorRecord.responses[1]!.isolateNonce = "isolate-B";
    changed.environments.deployed!.resourceCriteria = deployed;
    expect(isVerifiedHarnessRelease("green", changed)).toBe(false);

    const incomplete = greenTaggedResourceResult();
    const missing = taggedResourceCriteria("deployed");
    missing.platformPolicyCompliance!.collectorRecord.responses.pop();
    incomplete.environments.deployed!.resourceCriteria = missing;
    expect(isVerifiedHarnessRelease("green", incomplete)).toBe(false);

    const absentPlan = greenTaggedResourceResult();
    delete absentPlan.environments.deployed!.deployedResourceContext;
    expect(isVerifiedHarnessRelease("green", absentPlan)).toBe(false);

    const retiredLocal = greenTaggedResourceResult();
    retiredLocal.environments["local-workerd"]!.resourceCriteria = {
      ...taggedResourceCriteria("local-workerd"),
      status: "passed",
      label: "configured-limit completion with measured overshoot",
    };
    expect(isVerifiedHarnessRelease("green", retiredLocal)).toBe(false);

    const measuredPeak = greenTaggedResourceResult();
    measuredPeak.environments.deployed!.metrics.peakHeapBytes = { state: "measured", value: 128 };
    expect(isVerifiedHarnessRelease("green", measuredPeak)).toBe(false);

    const mislabeledTiming = greenTaggedResourceResult();
    const timing = mislabeledTiming.environments.deployed!.resourceCriteria as {
      startupUpperBound: { exactBootTime: boolean };
    };
    timing.startupUpperBound.exactBootTime = true;
    expect(isVerifiedHarnessRelease("green", mislabeledTiming)).toBe(false);
  });

  it("requires a complete deployed builtin verdict and retains fail-loud obligations", () => {
    const result = greenTaggedResourceResult();
    const local = result.environments["local-workerd"]!;
    const deployed = result.environments.deployed!;
    const obligation = {
      kind: "unsupported-fail-loud",
      siteId: "c".repeat(64),
      module: "release.js",
      specifier: "os",
      memberPath: ["getPriority"],
      failureCode: "NODE_OS_PRIORITY_UNSUPPORTED",
      state: "unreached",
    };
    const verdict = deployed.builtinCriteria as Record<string, unknown>;
    verdict.openObligations = [obligation];
    expect(isVerifiedHarnessRelease("green", result)).toBe(true);
    obligation.state = "awaiting-coverage";
    expect(isVerifiedHarnessRelease("green", result)).toBe(false);
    obligation.state = "unreached";
    obligation.failureCode = "";
    expect(isVerifiedHarnessRelease("green", result)).toBe(false);
    obligation.failureCode = "NODE_OS_PRIORITY_UNSUPPORTED";
    verdict.blockers = ["unknown call"];
    expect(isVerifiedHarnessRelease("green", result)).toBe(false);
    verdict.blockers = [];
    delete local.builtinCriteria;
    expect(isVerifiedHarnessRelease("green", result)).toBe(false);
  });

  it("rejects omitted obligations and capture-not-started even when summary flags stay green", () => {
    const missingObligations = greenTaggedResourceResult();
    const missing = builtinVerdict("deployed");
    missing.openObligations = [];
    missingObligations.environments.deployed!.builtinCriteria = missing;
    expect(isVerifiedHarnessRelease("green", missingObligations)).toBe(false);

    const absentCapture = greenTaggedResourceResult();
    const absent = builtinVerdict("deployed");
    absent.evidence.corpus.runs[0]!.captureState = "not-started";
    absent.evidence.corpus.runs[0]!.sources[0]!.executedByteRanges = [];
    absentCapture.environments.deployed!.builtinCriteria = absent;
    expect(isVerifiedHarnessRelease("green", absentCapture)).toBe(false);
  });

  it("recomputes inherited reached paths before accepting an unreached obligation", () => {
    const serialized = new Function(
      `${HARNESS_RELEASE_POLICY_SOURCE}\nreturn isVerifiedHarnessRelease;`,
    )() as typeof isVerifiedHarnessRelease;
    const result = greenTaggedResourceResult();
    const verdict = builtinVerdict("deployed");
    const originalArtifact = "f".repeat(64);
    const historical = {
      ...verdict.evidence.corpus.runs[0]!,
      kind: "a-series-replay",
      runId: "A34",
      artifactSha256: originalArtifact,
      sources: verdict.evidence.corpus.runs[0]!.sources.map((source) => ({
        ...source,
        invokedSiteIds: ["c".repeat(64)],
      })),
    };
    result.environments.deployed!.builtinCriteria = {
      ...verdict,
      evidence: {
        ...verdict.evidence,
        corpus: {
          ...verdict.evidence.corpus,
          runs: [...verdict.evidence.corpus.runs, historical],
          inheritedArtifacts: [
            {
              release: "303",
              artifactSha256: originalArtifact,
              inventory: verdict.evidence.inventory,
            },
          ],
        },
      },
    };
    expect(isVerifiedHarnessRelease("green", result)).toBe(false);
    expect(serialized("green", result)).toBe(false);
  });

  it("round-trips the resource guard in serialized watcher policy source", () => {
    const serialized = new Function(
      `${HARNESS_RELEASE_POLICY_SOURCE}\nreturn isVerifiedHarnessRelease;`,
    )() as typeof isVerifiedHarnessRelease;
    expect(serialized("green", greenTaggedResourceResult())).toBe(true);
    const malformed = greenTaggedResourceResult();
    (malformed.environments["local-workerd"]!.resourceCriteria as { tag: string }).tag = "unknown";
    expect(serialized("green", malformed)).toBe(false);
  });

  it("retries a failed red handoff by correlation ID before reusing the proof", async () => {
    const headSha = "a".repeat(40);
    const runKey = "harness-release:claude-code:2.1.303";
    const receiptKey = `${runKey}:${headSha}`;
    const run = loadRunRelease();
    const host = makeRedReleaseHost(headSha, runKey);
    const release = candidate("claude-code", "2.1.303", "current");
    const triggerAt = "2026-10-19T00:00:00.000Z";

    const first = await run(host.workflowTools, release, headSha, triggerAt);
    expect(first).toMatchObject({ status: "red", verified: false });
    expect(host.receipts.get(receiptKey)).toMatchObject({
      status: "red",
      proofArtifactVerified: true,
      handoffStatus: "unavailable",
    });

    host.issueAvailable = true;
    const retried = await run(host.workflowTools, release, headSha, triggerAt);
    expect(retried).toMatchObject({ status: "red", reused: true, verified: false });
    expect(host.receipts.get(receiptKey)).toMatchObject({
      status: "red",
      proofArtifactVerified: true,
      handoffStatus: "created",
      handoff: { number: 294 },
    });

    await run(host.workflowTools, release, headSha, triggerAt);
    expect(host.issueCalls).toHaveLength(2);
    expect(host.issueCalls.map((args) => args.correlationId)).toEqual([
      `${runKey}:${headSha}:red`,
      `${runKey}:${headSha}:red`,
    ]);
    expect(host.workflowActions).toEqual(["dispatch", "artifact"]);
    expect(host.ledgerActions).toEqual(["selection", "record"]);
  });
});

const loadRunRelease = () =>
  new Function(
    `${HARNESS_RELEASE_POLICY_SOURCE}\n${HARNESS_RELEASE_DISCOVERY_SOURCE}\n${HARNESS_RELEASE_EXECUTION_SOURCE}\nreturn runRelease;`,
  )() as (
    tools: {
      recall(label: string, key: string): Promise<unknown>;
      remember(label: string, key: string, value: unknown): Promise<unknown>;
      call(label: string, operation: string, args: Record<string, unknown>): Promise<unknown>;
      agent(label: string, options: { prompt: string }): Promise<unknown>;
    },
    release: HarnessReleaseCandidate,
    headSha: string,
    triggerAt: string,
  ) => Promise<unknown>;

const makeRedReleaseHost = (headSha: string, runKey: string) => {
  const receipts = new Map<string, unknown>();
  const workflowActions: string[] = [];
  const ledgerActions: string[] = [];
  const issueCalls: Array<Record<string, unknown>> = [];
  let issueAvailable = false;
  const result = {
    schemaVersion: 1,
    provider: "claude-code",
    version: "2.1.303",
    runKey,
    selection: "current",
    status: "red",
    source: { commit: headSha },
    stages: [{ name: "publicHarness", status: "rejected" }],
  };
  const workflowRun = {
    runId: "run-123",
    url: "https://github.com/JustYannicc/signalbox/actions/runs/run-123",
    workflowFile: ".github/workflows/harness-release-proof.yml",
    headSha,
    displayTitle: runKey,
    status: "completed",
    conclusion: "failure",
  };
  const artifact = {
    run: workflowRun,
    artifact: {
      id: "artifact-456",
      name: "harness-release-claude-code-2.1.303-run-123-1",
      digest: `sha256:${"b".repeat(64)}`,
      entryPath: "result.json",
      sha256: "c".repeat(64),
      bytes: 128,
    },
    text: JSON.stringify(result),
  };
  const workflowTools = {
    recall: async (_label: string, key: string) => receipts.get(key) ?? null,
    remember: async (_label: string, key: string, value: unknown) => {
      receipts.set(key, structuredClone(value));
    },
    agent: async () => ({ threadId: "release-thread" }),
    call: async (_label: string, operation: string, args: Record<string, unknown>) => {
      if (operation === "signalbox.harness_release_ledger") {
        const action = String(args.action);
        ledgerActions.push(action);
        return action === "selection"
          ? { revision: 0 }
          : {
              status: "pending",
              proofStatus: "red",
              proofArtifactVerified: true,
              runtimeArtifactVerified: false,
              result,
            };
      }
      if (operation === "signalbox.github_workflow") {
        const action = String(args.action);
        workflowActions.push(action);
        return action === "dispatch" ? workflowRun : artifact;
      }
      if (operation === "signalbox.github_issue") {
        issueCalls.push(structuredClone(args));
        if (!issueAvailable) throw new Error("GitHub is unavailable");
        return { number: 294, url: "https://github.com/JustYannicc/signalbox/issues/294" };
      }
      return { delivery: "queued" };
    },
  };

  return {
    receipts,
    workflowActions,
    ledgerActions,
    issueCalls,
    workflowTools,
    get issueAvailable() {
      return issueAvailable;
    },
    set issueAvailable(value: boolean) {
      issueAvailable = value;
    },
  };
};
