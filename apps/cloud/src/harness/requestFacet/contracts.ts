import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type {
  HarnessRunArtifact,
  HarnessRunStoreResult,
  HarnessRequestCheckpoint,
  HarnessRequestPublisher,
} from "../HarnessRunStore.ts";

export class HarnessRequestFacetError extends Error {
  readonly _tag = "HarnessRequestFacetError";
}

export interface HarnessFacetRequestContext {
  readonly requestId: string;
  readonly publisher: HarnessRequestPublisher;
  readonly signal: AbortSignal;
  /** Call at external-effect admission. Already admitted effects still require reconciliation. */
  readonly check: Effect.Effect<void, HarnessRequestFacetError>;
  readonly progress: (
    kind: string,
    reference: HarnessRunArtifact,
  ) => Effect.Effect<void, HarnessRequestFacetError>;
}

export interface HarnessFacetRequestRuntime {
  /** Returns only after the step settles and native files and workspace bytes are committed. */
  readonly run: (
    input: HarnessRunArtifact,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<
    {
      readonly status: "completed" | "failed";
      readonly result: HarnessRunArtifact;
      readonly checkpoint: HarnessRequestCheckpoint;
    },
    HarnessRequestFacetError
  >;
}

export interface HarnessRequestFacetPreparationRequest {
  readonly operationId: string;
  readonly targetFacetNonce: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
}

export interface HarnessRequestFacetPreparationEvidence {
  readonly facetNonce: string;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly manifestRevision: string;
  readonly joined: {
    readonly invocationRpc: boolean;
    readonly fetch: boolean;
    readonly ports: boolean;
  };
  /** Returned by the host callback, retained inside the facet, never sent over RPC. */
  readonly runtime: HarnessFacetRequestRuntime;
}

export type HarnessRequestFacetPreparationObservation = Omit<
  HarnessRequestFacetPreparationEvidence,
  "runtime"
>;

export interface HarnessRequestFacetOptions {
  readonly runId: string;
  /** Created once by the real facet constructor, never supplied by a recovered parent. */
  readonly facetNonce: string;
  readonly store: {
    readonly execute: (command: unknown) => Promise<HarnessRunStoreResult>;
  };
  readonly verify: (
    reference: HarnessRunArtifact,
    purpose: "input" | "native" | "filesystem" | "result" | "progress",
  ) => Effect.Effect<void, HarnessRequestFacetError>;
  /** Restores canonical files before opening the unchanged provider in this facet. */
  readonly open: (
    checkpoint: HarnessRequestCheckpoint,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<HarnessFacetRequestRuntime, HarnessRequestFacetError, Scope.Scope>;
  /** Restores the exact committed checkpoint without admitting a request or starting a model turn. */
  readonly prepareInert?: (
    input: HarnessRequestFacetPreparationRequest,
  ) => Effect.Effect<HarnessRequestFacetPreparationEvidence, HarnessRequestFacetError, Scope.Scope>;
}

export interface HarnessRequestFacet {
  readonly facetNonce: string;
  /** Each call must be a new incoming facet request; never detach the returned work. */
  readonly run: (input: {
    readonly publisher: HarnessRequestPublisher;
    readonly requestId: string;
  }) => Effect.Effect<HarnessRunStoreResult, HarnessRequestFacetError>;
  /** The runtime stays inside this facet; only serializable observed evidence crosses RPC. */
  readonly prepareInert: (
    input: HarnessRequestFacetPreparationRequest,
  ) => Effect.Effect<HarnessRequestFacetPreparationObservation, HarnessRequestFacetError>;
  readonly dispose: Effect.Effect<void>;
}
