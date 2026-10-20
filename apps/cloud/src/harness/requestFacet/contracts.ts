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
}

export interface HarnessRequestFacet {
  readonly facetNonce: string;
  /** Each call must be a new incoming facet request; never detach the returned work. */
  readonly run: (input: {
    readonly publisher: HarnessRequestPublisher;
    readonly requestId: string;
  }) => Effect.Effect<HarnessRunStoreResult, HarnessRequestFacetError>;
  readonly dispose: Effect.Effect<void>;
}
