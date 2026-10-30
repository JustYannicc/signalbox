import type { InheritedBuiltinObservation } from "@t3tools/shared/harnessReleaseInheritedReachability";
import type {
  NodeBuiltinCoverageReport,
  NodeBuiltinFunctionCall,
  NodeBuiltinFunctionStatus,
  NodeBuiltinSourceInventory,
} from "./coverage.ts";

export type BuiltinReachabilityMethod = "reached by executed range" | "observed invocation";

export interface BuiltinReachabilitySource {
  readonly module: string;
  readonly sourceSha256: string;
  readonly executedByteRanges: readonly {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly offsetUnit: "utf16-code-units";
    readonly executionCount: number;
  }[];
  readonly invokedSiteIds: readonly string[];
}

export interface BuiltinReachabilityRun {
  readonly kind: "a-series-replay" | "release-qualification";
  readonly runId: string;
  readonly artifactSha256: string;
  readonly completed: boolean;
  readonly captureState: "complete" | "incomplete" | "not-started";
  readonly evidenceSha256: string;
  readonly sources: readonly BuiltinReachabilitySource[];
}

export interface BuiltinReachabilityCorpus {
  readonly schemaVersion: 1;
  readonly runs: readonly BuiltinReachabilityRun[];
  readonly inheritedArtifacts?: readonly {
    readonly release: string;
    readonly artifactSha256: string;
    readonly inventory: NodeBuiltinReachabilityInventory;
  }[];
}

export interface BuiltinCallSite extends NodeBuiltinFunctionCall {
  readonly siteId: string;
  readonly sourceSha256: string;
  readonly status: NodeBuiltinFunctionStatus | "guarded";
  readonly evidence: string;
  readonly failure?: { readonly kind: "named-error"; readonly code: string };
}

export interface NodeBuiltinReachabilityInventory {
  readonly schemaVersion: 1;
  readonly sourceFiles: readonly NodeBuiltinSourceInventory[];
  readonly callSites: readonly BuiltinCallSite[];
  /** Static-only linked sites cannot prove V8 range reachability without a source map. */
  readonly analysisOnlyCallSites: readonly BuiltinCallSite[];
  readonly missingBuiltins: readonly string[];
  readonly unknownBuiltinSpecifiers: readonly string[];
  readonly ambiguities: NodeBuiltinCoverageReport["ambiguities"];
  readonly functionAmbiguities: NodeBuiltinCoverageReport["functionAmbiguities"];
}

export interface NodeBuiltinReachabilityAssessment {
  readonly schemaVersion: 1;
  readonly artifactSha256: string;
  readonly evidence: {
    readonly inventory: NodeBuiltinReachabilityInventory;
    readonly corpus: BuiltinReachabilityCorpus;
  };
  readonly coverageStatus: "passed" | "pending" | "rejected";
  readonly observation: {
    readonly method: BuiltinReachabilityMethod;
    readonly limitation: string;
  };
  readonly qualifiedRunId?: string;
  readonly reachedSites: readonly {
    readonly siteId: string;
    readonly module: string;
    readonly specifier: string;
    readonly memberPath: readonly string[];
    readonly status: NodeBuiltinFunctionStatus | "guarded";
    readonly method: BuiltinReachabilityMethod;
    readonly runId: string;
    readonly inheritedFrom?: readonly InheritedBuiltinObservation[];
  }[];
  readonly removedApiPaths: readonly {
    readonly specifier: string;
    readonly memberPath: readonly string[];
    readonly inheritedFrom: readonly InheritedBuiltinObservation[];
  }[];
  readonly unmappedAnalysisSites: readonly {
    readonly siteId: string;
    readonly module: string;
    readonly specifier: string;
    readonly memberPath: readonly string[];
    readonly status: NodeBuiltinFunctionStatus | "guarded";
  }[];
  readonly blockers: readonly string[];
  readonly openObligations: readonly {
    readonly kind: "unsupported-fail-loud" | "guarded-missing";
    readonly siteId: string;
    readonly module: string;
    readonly specifier: string;
    readonly memberPath: readonly string[];
    readonly failureCode?: string;
    readonly guardExpression?: string;
    readonly state: "awaiting-coverage" | "unreached" | "awaiting-named-error";
  }[];
  readonly excludedRuns: readonly { readonly runId: string; readonly reason: string }[];
}
