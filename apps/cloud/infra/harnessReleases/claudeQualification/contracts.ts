import type { HarnessReleaseArtifactIdentity } from "../../../src/harnessReleases/HarnessReleaseArtifact.ts";
import type { HarnessReleaseArtifact } from "../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessProcessResumePreparedRelease } from "../../../src/harness/HarnessProcessResume.ts";
import type {
  HarnessRequestFacetCreationObservation,
  HarnessRequestFacetCreationRequest,
} from "../../../src/harness/HarnessRequestFacet.ts";

export interface CandidateFilePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ClaudePairCandidate {
  readonly schema: "signalbox/claude-release-pair-candidate/v1";
  readonly status: "candidate";
  readonly qualification: "pending";
  readonly source: unknown;
  readonly trustedComputer: {
    readonly sourceIdentity: string;
    readonly manifestSha256: string;
  };
  readonly maxPreparedModuleBytes: number;
  readonly variants: Readonly<Record<"baseline" | "hooks", HarnessReleaseArtifactIdentity>>;
  readonly ledger: CandidateFilePin;
  readonly descriptor: CandidateFilePin;
}

export interface ClaudeReleaseLedgerCandidate {
  readonly schema: "signalbox/claude-release-ledger-candidate/v1";
  readonly status: "candidate";
  readonly qualification: "pending";
  readonly scope: "global" | "project";
  readonly variants: Readonly<
    Record<"baseline" | "hooks", { readonly artifact: HarnessReleaseArtifact }>
  >;
  readonly eligibility: Readonly<
    Record<
      "baseline" | "hooks",
      { readonly status: "pending"; readonly reasons: readonly string[] }
    >
  >;
  readonly files: { readonly ledger: CandidateFilePin };
}

export type ClaudeQualificationVariant = "baseline" | "hooks";

export interface PublicClaudeQualificationFacet {
  identity(): Promise<{ readonly facetNonce: string }>;
  startFresh(
    request: Omit<HarnessRequestFacetCreationRequest, "targetFacetNonce"> & {
      readonly targetFacetNonce: string;
    },
  ): Promise<HarnessRequestFacetCreationObservation>;
  loadedPreparedRelease(): Promise<HarnessProcessResumePreparedRelease>;
  dispose(expectedFacetNonce: string): Promise<void>;
}

export interface ColdFirstSuccessfulRpcTiming {
  readonly label: "cold first-successful-RPC latency";
  readonly interpretation: "startup upper bound";
  readonly clock: "parent process.hrtime.bigint";
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly milliseconds: number;
  readonly includesRpc: true;
  readonly exactBootTime: false;
}

export interface ColdFirstSuccessfulRpcTimer {
  readonly measureColdFirstSuccessfulRpc: <A>(
    invokeCold: () => Promise<A>,
  ) => Promise<{ readonly value: A; readonly timing: ColdFirstSuccessfulRpcTiming }>;
}

export interface CalibrationFilePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ClaudeQualificationColdStartupInput {
  readonly acquireFacet: () => Promise<PublicClaudeQualificationFacet>;
  readonly timer: ColdFirstSuccessfulRpcTimer;
  readonly expected: HarnessProcessResumePreparedRelease;
  readonly scenario: ClaudeQualificationVariant;
  readonly operationId: string;
  readonly publisherKey: string;
  readonly calibrationPins: readonly CalibrationFilePin[];
}

export interface ClaudeQualificationColdStartupObservation {
  readonly schema: "signalbox/claude-qualification-observation/v1";
  readonly classification: "runtime-observation";
  readonly status: "pending";
  readonly scenario: ClaudeQualificationVariant;
  readonly coldStartupUpperBound: ColdFirstSuccessfulRpcTiming;
  readonly loadedPreparedRelease: HarnessProcessResumePreparedRelease;
  readonly creation: HarnessRequestFacetCreationObservation;
  readonly resourceEvidence: {
    readonly schema: "signalbox/claude-configured-limit-resource-evidence/v1";
    readonly criterion: "configured-limit completion with measured overshoot";
    readonly status: "pending";
    readonly strictByteBound: false;
    readonly calibrationPins: ReadonlyArray<CalibrationFilePin>;
    readonly workloadCompletion: {
      readonly status: "not-run";
      readonly reason: string;
    };
    readonly sessionClose: {
      readonly status: "closed";
      readonly acknowledged: true;
    };
    readonly deployedPolicyEvidence: {
      readonly status: "pending";
      readonly label: "platform policy compliance evidence";
    };
  };
  readonly criteria: ReadonlyArray<{
    readonly name:
      | "boot"
      | "text"
      | "readEdit"
      | "bash"
      | "grep"
      | "resume"
      | "mcp"
      | "interrupt"
      | "publicHarness";
    readonly status: "pending";
    readonly detail: string;
  }>;
  readonly metrics: {
    readonly bootTimeMs: {
      readonly state: "unmeasured";
      readonly reason: string;
    };
    readonly peakHeapBytes: {
      readonly state: "unmeasured";
      readonly reason: string;
    };
  };
}
