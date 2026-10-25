import type * as Effect from "effect/Effect";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessDurableStatePublicationResult } from "../HarnessDurableState.ts";
import type { HarnessProcessPlacementIdentity } from "../HarnessProcessPlacement.ts";
import type { HarnessReleasePlan } from "../HarnessReleasePlan.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../HarnessThreadSupervisor.ts";
import type { HarnessProcessResumeDriverError } from "./errors.ts";

export interface HarnessProcessResumeCheckpointReference {
  readonly checkpointId: string;
  readonly manifestSha256: string;
  readonly nativeSessionId: string;
}

/** Identity-only projection of the plan returned by loading the selected artifact. */
export type HarnessProcessResumeLoadedRelease = Pick<
  HarnessReleasePlan,
  "release" | "sourceIdentity" | "computer" | "preparedModules"
>;

/** The selected ledger artifact stays paired with the loader result through this transition. */
export interface HarnessProcessResumePreparedRelease {
  readonly artifact: HarnessReleaseArtifact;
  /** A plan is a verified load result, not a qualification or selection decision. */
  readonly plan: HarnessProcessResumeLoadedRelease;
}

export interface HarnessProcessResumePreparedFacet {
  readonly identity: HarnessProcessPlacementIdentity & {
    /** Read from the fresh facet's actual loaded release, never copied from its request. */
    readonly preparedRelease?: HarnessProcessResumePreparedRelease;
  };
}

export interface HarnessProcessResumeFacetCode {
  readonly processId: string;
  readonly codeId: string;
  readonly residentBytes: number;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string | { readonly js: string }>>;
  readonly entrypoint: string;
}

/** Serializable input to the shard DO. It cannot choose or supply a runtime context or handle. */
export interface HarnessProcessResumeOperationInput {
  readonly runId: string;
  readonly previousProcessId: string;
  readonly previousOperationId: string;
  readonly previousStepId: string;
  readonly transition: HarnessProcessResumeInput;
  readonly facet: HarnessProcessResumeFacetCode;
}

export type HarnessProcessResumeStage =
  | "fence"
  | "drain"
  | "settlement"
  | "checkpoint"
  | "fresh-open"
  | "fresh-verification"
  | "publication"
  | "activation"
  | "cleanup"
  | "recovery";

export type HarnessProcessResumeRecovery =
  | "recorded"
  | "claim-changed"
  | "record-failed"
  | "not-recorded";

export type HarnessProcessResumeCheckpointOutcome<Checkpoint> =
  | { readonly _tag: "committed"; readonly checkpoint: Checkpoint }
  | { readonly _tag: "indeterminate" }
  | { readonly _tag: "stale-control" };

export type HarnessProcessResumePublicationResult = HarnessDurableStatePublicationResult;

export type HarnessProcessResumeCleanup<CleanupEvidence> =
  | { readonly _tag: "complete"; readonly evidence: CleanupEvidence }
  | { readonly _tag: "incomplete"; readonly evidence: CleanupEvidence };

export interface HarnessProcessResumeInput {
  readonly operationId: string;
  readonly control: HarnessThreadSupervisorControlClaim;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly nextControl: HarnessThreadSupervisorControlClaim;
  readonly expectedFacetGeneration: number;
  /** Immutable identity supplied by #1070/#1451, paired with its verified loader projection. */
  readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
}

/** The production adapter maps these steps to the durable supervisor and placement roots. */
export interface HarnessProcessResumeDriver<
  Drain,
  Checkpoint extends HarnessProcessResumeCheckpointReference,
  PreparedFacet extends HarnessProcessResumePreparedFacet,
  Publication extends HarnessProcessResumePublicationResult,
  CleanupEvidence,
> {
  /** Fences new admissions before returning the drain receipt. */
  readonly beginDrain: (
    input: HarnessProcessResumeInput,
  ) => Effect.Effect<Drain, HarnessProcessResumeDriverError>;
  /** Returns only after the admitted checkpoint is committed and stop/join evidence is recorded. */
  readonly awaitDrain: (
    drain: Drain,
  ) => Effect.Effect<
    HarnessProcessResumeCheckpointOutcome<Checkpoint>,
    HarnessProcessResumeDriverError
  >;
  /** Rechecks the control claim that owns this drain before a fresh process is opened. */
  readonly isCurrentControl: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
  }) => Effect.Effect<boolean, HarnessProcessResumeDriverError>;
  readonly readNativeSessionId: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
  }) => Effect.Effect<string, HarnessProcessResumeDriverError>;
  /** Reads and verifies the exact persisted checkpoint bytes. */
  readonly verifyCheckpoint: (input: {
    readonly checkpoint: Checkpoint;
    readonly nativeSessionId: string;
  }) => Effect.Effect<void, HarnessProcessResumeDriverError>;
  /** Opens a fresh facet without admitting a turn or external effect. */
  readonly prepareInert: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly publisher: HarnessThreadSupervisorPublisher;
    readonly operationId: string;
    readonly checkpoint: Checkpoint;
    readonly nativeSessionId: string;
    readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
    readonly expectedFacetGeneration: number;
  }) => Effect.Effect<PreparedFacet, HarnessProcessResumeDriverError>;
  /** Checks restored checkpoint bytes and fresh process identity while the facet is inert. */
  readonly verifyPrepared: (input: {
    readonly drain: Drain;
    readonly prepared: PreparedFacet;
    readonly checkpoint: Checkpoint;
    readonly nativeSessionId: string;
    readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
  }) => Effect.Effect<void, HarnessProcessResumeDriverError>;
  /** Persists the verified prepared identity before publication can change authority. */
  readonly persistPrepared: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly publisher: HarnessThreadSupervisorPublisher;
    readonly operationId: string;
    readonly prepared: PreparedFacet;
    readonly checkpoint: Checkpoint;
    readonly nativeSessionId: string;
    readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
    readonly expectedFacetGeneration: number;
  }) => Effect.Effect<void, HarnessProcessResumeDriverError>;
  /** Uses HarnessDurableState's one cross-DO publication operation. */
  readonly publishFreshFacet: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly operationId: string;
    readonly prepared: PreparedFacet;
    readonly checkpoint: Checkpoint;
    readonly nativeSessionId: string;
    readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
    readonly expectedFacetGeneration: number;
  }) => Effect.Effect<Publication, HarnessProcessResumeDriverError>;
  /** Calls placement.activate with the complete publication receipt. */
  readonly activate: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly operationId: string;
    readonly prepared: PreparedFacet;
    readonly publication: Extract<Publication, { readonly status: "published" }>;
  }) => Effect.Effect<void, HarnessProcessResumeDriverError>;
  /** Uses placement cleanup, which proves stop and joined settlement before releasing the lease. */
  readonly cleanupPrepared: (
    prepared: PreparedFacet,
  ) => Effect.Effect<HarnessProcessResumeCleanup<CleanupEvidence>, HarnessProcessResumeDriverError>;
  /** Persists recoverable, indeterminate, or activation-failed state under the current claim. */
  readonly recordFailure: (input: {
    readonly drain: Drain;
    readonly control: HarnessThreadSupervisorControlClaim;
    readonly operationId: string;
    readonly expectedFacetGeneration: number;
    readonly targetPreparedRelease: HarnessProcessResumePreparedRelease;
    readonly stage: HarnessProcessResumeStage;
    readonly failedStage?: HarnessProcessResumeStage;
    readonly reason: string;
    readonly priorReason?: string;
    readonly prepared?: PreparedFacet;
    readonly publication?: Publication;
    readonly cleanup: HarnessProcessResumeCleanup<CleanupEvidence> | null;
  }) => Effect.Effect<HarnessProcessResumeRecovery, HarnessProcessResumeDriverError>;
}

export interface HarnessProcessResumeResult<
  PreparedFacet extends HarnessProcessResumePreparedFacet,
  Publication extends HarnessProcessResumePublicationResult,
> {
  readonly preparedFacet: PreparedFacet;
  readonly publication: Extract<Publication, { readonly status: "published" }>;
}
