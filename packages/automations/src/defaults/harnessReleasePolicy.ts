export type HarnessReleaseProvider = "claude-code" | "claude-agent-sdk" | "codex";
export type HarnessReleaseSelection = "current" | "backfill";

export const HARNESS_RELEASE_WORKFLOW_FILE = ".github/workflows/harness-release-proof.yml";
export const HARNESS_RELEASE_RESULT_PATH = "result.json";
export const HARNESS_RELEASE_BACKFILL_LIMITS = {
  "claude-code": 50,
  "claude-agent-sdk": 0,
  codex: 10,
} as const satisfies Record<HarnessReleaseProvider, number>;
export const HARNESS_RELEASE_CODEX_MAX_PAGES = 10;

export const releaseArtifactName = (
  provider: HarnessReleaseProvider,
  version: string,
  runId: string,
) => `harness-release-${provider}-${version}-${runId}-1`;

export interface HarnessReleaseCandidate {
  readonly id: string;
  readonly provider: HarnessReleaseProvider;
  readonly version: string;
  readonly upstreamIdentity: string;
  readonly selection: HarnessReleaseSelection;
}

export const releaseRunKey = (provider: HarnessReleaseProvider, version: string) =>
  `harness-release:${provider}:${version}`;

export const releaseReceiptKey = (
  provider: HarnessReleaseProvider,
  version: string,
  headSha: string,
) => `${releaseRunKey(provider, version)}:${headSha}`;

/** Reuse only a completed result that the native ledger recorded. */
export const shouldReuseReleaseReceipt = (
  receipt:
    | {
        readonly runKey?: unknown;
        readonly headSha?: unknown;
        readonly status?: unknown;
        readonly ledgerStatus?: unknown;
        readonly workflowStatus?: unknown;
        readonly proofArtifactVerified?: unknown;
        readonly runtimeArtifactVerified?: unknown;
      }
    | null
    | undefined,
  runKey: string,
  headSha: string,
) =>
  receipt?.runKey === runKey &&
  receipt.headSha === headSha &&
  receipt.workflowStatus === "completed" &&
  ((receipt.status === "green" &&
    receipt.ledgerStatus === "recorded" &&
    receipt.proofArtifactVerified === true &&
    receipt.runtimeArtifactVerified === true) ||
    ((receipt.status === "red" || receipt.status === "pending") &&
      receipt.proofArtifactVerified === true));

/** Resume an exact in-flight run; only a complete authoritative receipt is terminal. */
export const releaseReceiptDisposition = (
  receipt:
    | {
        readonly runKey?: unknown;
        readonly headSha?: unknown;
        readonly workflowRunId?: unknown;
        readonly status?: unknown;
        readonly ledgerStatus?: unknown;
        readonly workflowStatus?: unknown;
        readonly proofArtifactVerified?: unknown;
        readonly runtimeArtifactVerified?: unknown;
      }
    | null
    | undefined,
  runKey: string,
  headSha: string,
) => {
  if (receipt?.runKey !== runKey || receipt.headSha !== headSha) return "dispatch" as const;
  if (shouldReuseReleaseReceipt(receipt, runKey, headSha)) return "reuse" as const;
  return typeof receipt.workflowRunId === "string" && receipt.workflowRunId !== ""
    ? ("read" as const)
    : ("dispatch" as const);
};

/** Keep the current release ahead of a bounded historical batch. */
export const orderReleaseCandidates = (
  releases: ReadonlyArray<HarnessReleaseCandidate>,
): ReadonlyArray<HarnessReleaseCandidate> => {
  const priority: Record<HarnessReleaseProvider, number> = {
    "claude-code": 0,
    "claude-agent-sdk": 1,
    codex: 2,
  };
  const current = releases
    .filter((release) => release.selection === "current")
    .sort((left, right) => priority[left.provider] - priority[right.provider]);
  const seenCurrent = new Set<HarnessReleaseProvider>();
  const uniqueCurrent = current.filter((release) => {
    if (seenCurrent.has(release.provider)) return false;
    seenCurrent.add(release.provider);
    return true;
  });
  const limits: Record<HarnessReleaseProvider, number> = HARNESS_RELEASE_BACKFILL_LIMITS;
  const counts: Record<HarnessReleaseProvider, number> = {
    "claude-code": 0,
    "claude-agent-sdk": 0,
    codex: 0,
  };
  const seenIds = new Set(uniqueCurrent.map((release) => release.id));
  const backfill = releases
    .filter((release) => release.selection === "backfill")
    .sort((left, right) => priority[left.provider] - priority[right.provider])
    .filter((release) => {
      if (seenIds.has(release.id) || counts[release.provider] >= limits[release.provider])
        return false;
      seenIds.add(release.id);
      counts[release.provider] += 1;
      return true;
    });
  return [...uniqueCurrent, ...backfill];
};

/** Hold historical work until every provider has exact green current proof. */
export const nextHarnessReleaseBatch = (
  releases: ReadonlyArray<HarnessReleaseCandidate>,
  verifiedCurrentProviders: ReadonlyArray<HarnessReleaseProvider> = [],
  terminalBackfillIds: ReadonlyArray<string> = [],
) => {
  const ordered = orderReleaseCandidates(releases);
  const current = ordered.filter((release) => release.selection === "current");
  const requiredCurrentProviders: ReadonlyArray<HarnessReleaseProvider> = [
    "claude-code",
    "claude-agent-sdk",
    "codex",
  ];
  const readyForBackfill = requiredCurrentProviders.every(
    (provider) =>
      current.some((release) => release.provider === provider) &&
      verifiedCurrentProviders.includes(provider),
  );
  if (!readyForBackfill) return current;

  const terminal = new Set(terminalBackfillIds);
  const backfill = ordered.filter(
    (release) => release.selection === "backfill" && !terminal.has(release.id),
  );
  return [
    ...current,
    ...backfill.filter((release) => release.provider === "claude-code").slice(0, 1),
    ...backfill.filter((release) => release.provider === "codex").slice(0, 1),
  ];
};

/** Count only exact, completed immutable proofs in the current source snapshot. */
export const summarizeHarnessBackfill = (
  releases: ReadonlyArray<HarnessReleaseCandidate>,
  receipts: ReadonlyArray<{
    readonly discoveryId?: unknown;
    readonly runKey?: unknown;
    readonly headSha?: unknown;
    readonly workflowStatus?: unknown;
    readonly proofStatus?: unknown;
    readonly proofArtifactVerified?: unknown;
  }>,
  headSha: string,
) => {
  const backfill = orderReleaseCandidates(releases).filter(
    (release) => release.selection === "backfill",
  );
  let green = 0;
  let red = 0;
  let pending = 0;
  let terminal = 0;
  for (const release of backfill) {
    const receipt = receipts.find(
      (candidate) =>
        candidate.discoveryId === release.id &&
        candidate.runKey === releaseRunKey(release.provider, release.version) &&
        candidate.headSha === headSha &&
        candidate.workflowStatus === "completed" &&
        candidate.proofArtifactVerified === true,
    );
    if (receipt === undefined) continue;
    terminal += 1;
    if (receipt?.proofStatus === "green") green += 1;
    else if (receipt?.proofStatus === "red") red += 1;
    else pending += 1;
  }
  return {
    total: backfill.length,
    terminal,
    green,
    red,
    pending,
    acceptance:
      backfill.length === 0
        ? ("pending" as const)
        : terminal < backfill.length
          ? ("in-progress" as const)
          : green / backfill.length >= 0.9
            ? ("met" as const)
            : ("missed" as const),
  };
};

/** The release CLI's public criteria and measurements are the only green proof. */
export const isVerifiedHarnessRelease = (
  status: string,
  result: {
    readonly status?: string;
    readonly unchangedSource?: string;
    readonly environments?: Record<
      string,
      | {
          readonly checks?: ReadonlyArray<{ readonly name: string; readonly status: string }>;
          readonly metrics?: Record<
            string,
            | { readonly state: "measured"; readonly value: number }
            | { readonly state: "unmeasured"; readonly reason?: string }
            | undefined
          >;
        }
      | undefined
    >;
  } | null,
) => {
  if (status !== "green" || result?.status !== "green" || result.unchangedSource !== "passed")
    return false;
  const requiredChecks = [
    "boot",
    "text",
    "readEdit",
    "bash",
    "grep",
    "resume",
    "mcp",
    "interrupt",
    "publicHarness",
  ];
  const requiredMetrics = ["moduleBytes", "bootTimeMs", "peakHeapBytes"];
  for (const environment of ["local-workerd", "deployed"]) {
    const assessment = result.environments?.[environment];
    if (
      !assessment?.checks ||
      assessment.checks.length !== requiredChecks.length ||
      requiredChecks.some(
        (name) => assessment.checks?.filter((check) => check.name === name).length !== 1,
      ) ||
      assessment.checks.some((check) => check.status !== "passed")
    )
      return false;
    for (const name of requiredMetrics) {
      const metric = assessment.metrics?.[name];
      if (metric?.state !== "measured" || !Number.isFinite(metric.value) || metric.value < 0)
        return false;
    }
  }
  return true;
};

export const canPromoteHarnessRelease = (input: {
  readonly selection: HarnessReleaseSelection;
  readonly status: string;
  readonly runtimeArtifactVerified: boolean;
  readonly expectedRevision: number | null;
  readonly currentRevision: number | null;
  readonly result: Parameters<typeof isVerifiedHarnessRelease>[1];
}) => {
  if (
    input.selection !== "current" ||
    !input.runtimeArtifactVerified ||
    input.expectedRevision === null ||
    input.currentRevision !== input.expectedRevision
  )
    return false;
  return isVerifiedHarnessRelease(input.status, input.result);
};

export const ledgerProviderFor = (provider: HarnessReleaseProvider) =>
  provider === "claude-agent-sdk" ? "agent-sdk" : provider;
