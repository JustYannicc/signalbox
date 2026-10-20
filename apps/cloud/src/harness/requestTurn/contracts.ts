import type { RunnerItem, RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { HarnessCheckpoint } from "../Harness.ts";
import type {
  HarnessFacetRequestContext,
  HarnessRequestFacetError,
} from "../HarnessRequestFacet.ts";
import type { HarnessRequestCheckpoint, HarnessRunArtifact } from "../HarnessRunStore.ts";
import type { HarnessHostOptions, HostOpenInput, TurnAccess } from "../HarnessSessionHost.ts";

export interface HarnessRequestTurnGate {
  /** Resolves the active request on every admission, including during later turns. */
  readonly check: Effect.Effect<void, HarnessRequestFacetError>;
  readonly signal: () => AbortSignal;
}

export interface HarnessRequestTurnInput<G> {
  readonly turn: RunnerTurn;
  readonly access: TurnAccess<G>;
}

export type HarnessRequestTurnTerminal = Extract<RunnerItem, { readonly kind: "provider" }>;

export interface HarnessRequestTurnOptions<G> {
  /** Restore committed native and filesystem bytes before returning host construction options. */
  readonly restore: (
    checkpoint: HarnessRequestCheckpoint,
    gate: HarnessRequestTurnGate,
  ) => Effect.Effect<
    { readonly host: HarnessHostOptions<G>; readonly open: HostOpenInput<G> },
    HarnessRequestFacetError,
    Scope.Scope
  >;
  readonly readInput: (
    reference: HarnessRunArtifact,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<HarnessRequestTurnInput<G>, HarnessRequestFacetError>;
  /** Return only after this exact RunnerItem has been durably published. */
  readonly onEvent: (
    item: RunnerItem,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<HarnessRunArtifact, HarnessRequestFacetError>;
  /** Preserve the terminal event, including its status and failure, in the result artifact. */
  readonly writeResult: (
    input: { readonly turn: RunnerTurn; readonly terminal: HarnessRequestTurnTerminal },
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<HarnessRunArtifact, HarnessRequestFacetError>;
  /** Persist the real export and its revision's committed bytes; return verified artifact refs. */
  readonly writeCheckpoint: (
    checkpoint: HarnessCheckpoint,
    context: HarnessFacetRequestContext,
  ) => Effect.Effect<HarnessRequestCheckpoint, HarnessRequestFacetError>;
  readonly verify: (
    reference: HarnessRunArtifact,
    purpose: "input" | "native" | "filesystem" | "result" | "progress",
  ) => Effect.Effect<void, HarnessRequestFacetError>;
}
