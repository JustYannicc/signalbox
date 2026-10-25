export type HarnessProvider = "claude-code" | "agent-sdk" | "codex";
export type HarnessProofEnvironment = "local-workerd" | "deployed-do";
export type HarnessProofCheck =
  | "unchangedSource"
  | "boot"
  | "toolTurn"
  | "resume"
  | "mcp"
  | "interrupt";
export type HarnessCheckResult = "pending" | "passed" | "rejected";
export type HarnessMetric =
  | { readonly state: "measured"; readonly value: number }
  | { readonly state: "unmeasured"; readonly reason: string };

export interface HarnessReleaseArtifact {
  readonly provider: HarnessProvider;
  readonly releaseId: string;
  readonly artifactHash: string;
  readonly artifactRef: string;
  readonly sourceIdentity: string;
  readonly fixtureIdentity: string;
  readonly createdAt: string;
}

export interface HarnessReleaseProof {
  readonly proofId: string;
  readonly provider: HarnessProvider;
  readonly releaseId: string;
  readonly artifactHash: string;
  readonly sourceIdentity: string;
  readonly fixtureIdentity: string;
  readonly environment: HarnessProofEnvironment;
  readonly recordedAt: string;
  readonly checks: Readonly<Record<HarnessProofCheck, HarnessCheckResult>>;
  readonly metrics: Readonly<{
    bootTimeMs: HarnessMetric;
    moduleBytes: HarnessMetric;
    peakHeapBytes: HarnessMetric;
  }>;
}

export type HarnessSelectionAction = "green" | "pinback";

export interface HarnessReleaseSelection {
  readonly provider: HarnessProvider;
  readonly revision: number;
  readonly currentReleaseId: string | null;
  readonly lastGreenReleaseId: string | null;
  readonly action: HarnessSelectionAction | null;
  readonly changedAt: string | null;
}

export interface HarnessReleaseSelectionEvent {
  readonly provider: HarnessProvider;
  readonly revision: number;
  readonly action: HarnessSelectionAction;
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string;
  readonly lastGreenReleaseId: string;
  readonly changedAt: string;
  readonly reason: string | null;
}

export type HarnessEligibilityReason =
  | "missing-local-proof"
  | "missing-deployed-proof"
  | "checks-pending"
  | "checks-rejected"
  | "metrics-unmeasured";

export type HarnessReleaseEligibility =
  | { readonly status: "green"; readonly reasons: readonly [] }
  | { readonly status: "pending"; readonly reasons: readonly HarnessEligibilityReason[] }
  | { readonly status: "rejected"; readonly reasons: readonly HarnessEligibilityReason[] };

export type HarnessReleaseSelectionResult =
  | { readonly status: "selected"; readonly selection: HarnessReleaseSelection }
  | { readonly status: "conflict"; readonly selection: HarnessReleaseSelection }
  | {
      readonly status: "not-green";
      readonly selection: HarnessReleaseSelection;
      readonly eligibility: HarnessReleaseEligibility;
    }
  | {
      readonly status: "never-green";
      readonly selection: HarnessReleaseSelection;
    };

export interface HarnessReleaseLedgerTransaction {
  getArtifact(provider: HarnessProvider, releaseId: string): HarnessReleaseArtifact | null;
  insertArtifact(artifact: HarnessReleaseArtifact): void;
  getProof(proofId: string): HarnessReleaseProof | null;
  appendProof(proof: HarnessReleaseProof): void;
  listProofs(provider: HarnessProvider, releaseId: string): ReadonlyArray<HarnessReleaseProof>;
  getSelection(provider: HarnessProvider): HarnessReleaseSelection;
  compareAndSwapSelection(
    provider: HarnessProvider,
    expectedRevision: number,
    next: HarnessReleaseSelection,
  ): boolean;
  appendSelectionEvent(event: HarnessReleaseSelectionEvent): void;
  listSelectionEvents(provider: HarnessProvider): ReadonlyArray<HarnessReleaseSelectionEvent>;
  wasEverGreen(provider: HarnessProvider, releaseId: string): boolean;
}

export interface HarnessReleaseLedgerStore {
  transaction<T>(operation: (transaction: HarnessReleaseLedgerTransaction) => T): T;
}

export interface HarnessReleaseLedger {
  registerArtifact(input: HarnessReleaseArtifact): HarnessReleaseArtifact;
  recordProof(input: HarnessReleaseProof): HarnessReleaseProof;
  getArtifact(provider: HarnessProvider, releaseId: string): HarnessReleaseArtifact | null;
  listProofs(provider: HarnessProvider, releaseId: string): ReadonlyArray<HarnessReleaseProof>;
  getEligibility(provider: HarnessProvider, releaseId: string): HarnessReleaseEligibility;
  getSelection(provider: HarnessProvider): HarnessReleaseSelection;
  resolveCurrent(provider: HarnessProvider): HarnessReleaseArtifact | null;
  listSelectionEvents(provider: HarnessProvider): ReadonlyArray<HarnessReleaseSelectionEvent>;
  compareAndSwapLastGreen(input: {
    readonly provider: HarnessProvider;
    readonly releaseId: string;
    readonly expectedRevision: number;
    readonly changedAt: string;
  }): HarnessReleaseSelectionResult;
  pinBack(input: {
    readonly provider: HarnessProvider;
    readonly releaseId: string;
    readonly expectedRevision: number;
    readonly changedAt: string;
    readonly reason: string;
  }): HarnessReleaseSelectionResult;
}
