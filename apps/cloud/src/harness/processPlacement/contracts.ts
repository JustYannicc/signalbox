import type {
  ProcessSlotLease,
  ProcessSlotPermit,
  ProcessSlotPressure,
  ProcessSlotRequest,
  ProcessSlotSignals,
  ProcessSlotsOptions,
  ProcessSlotStore,
} from "../../computer/ProcessSlots.ts";
import type { HarnessRequestPublisher } from "../HarnessRunStore.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";

export type HarnessProcessPlacementContext = "durable-object" | "worker-request";

export interface HarnessProcessPlacementIdentity {
  readonly shardOwner: string;
  readonly loaderId: string;
  readonly facetKey: string;
  readonly incarnationNonce: string;
}

export type HarnessProcessFacetLocator = Omit<HarnessProcessPlacementIdentity, "incarnationNonce">;

export interface HarnessProcessControllerClaim {
  readonly ownerId: string;
  readonly incarnationId: string;
  readonly epoch: number;
  readonly controlKey: string;
}

/** Structurally accepts the composed HarnessDurableState result without copying its receipt. */
export interface HarnessProcessPublicationReceipt {
  readonly operationId: string;
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly priorFacetNonce: string;
  readonly preparedFacetNonce: string;
  readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
  readonly status: "pending" | "confirmed";
}

export interface HarnessProcessPublication {
  readonly status: "published" | "supervisor-pending" | "files-pending";
  /** Published success carries the full claim checked by the composed durable-state operation. */
  readonly control?: HarnessProcessControllerClaim;
  readonly receipt?: HarnessProcessPublicationReceipt | null;
  readonly files?: { readonly publication?: HarnessProcessPublicationReceipt | null };
  readonly supervisor?: {
    readonly currentPublisher: { readonly generation: number; readonly facetNonce: string };
    readonly snapshot: {
      readonly lifecycle: string;
      readonly ownerId: string;
      readonly controlIncarnationId: string;
      readonly controlEpoch: number;
      readonly nativeSessionId: string;
      readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
      readonly generation: number;
      readonly facetNonce: string;
      readonly lastPublicationOperationId: string | null;
      readonly lastPublication: {
        readonly operationId: string;
        readonly fromGeneration: number;
        readonly toGeneration: number;
        readonly priorFacetNonce: string;
        readonly preparedFacetNonce: string;
        readonly checkpoint: { readonly checkpointId: string; readonly manifestSha256: string };
      } | null;
    };
  } | null;
}

/** The caller returns A's actual publication result and its authorized request publisher. */
export interface HarnessProcessPublishedActivation {
  readonly publication: HarnessProcessPublication;
  readonly publisher: HarnessRequestPublisher;
  readonly requestId: string;
}

export interface HarnessProcessPublicationRequest {
  readonly identity: HarnessProcessPlacementIdentity;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly operationId: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration: number;
}

export interface HarnessProcessPublicationPublisher {
  publishProcessFacet(
    input: HarnessProcessPublicationRequest,
  ): Promise<HarnessProcessPublishedActivation>;
}

export type HarnessProcessPublicationReconciliation =
  | { readonly status: "published"; readonly publication: HarnessProcessPublication }
  | {
      readonly status: "not-published";
      readonly controllerClaim: HarnessProcessControllerClaim;
      readonly operationId: string;
      readonly currentPublisher: {
        readonly generation: number;
        readonly facetNonce: string;
      };
      readonly lastPublicationOperationId: string | null;
    }
  | { readonly status: "pending" | "unknown" };

/** Reads the durable disposition of one exact publication operation without retrying it. */
export interface HarnessProcessPublicationReconciler {
  reconcileProcessFacetPublication(
    input: HarnessProcessPublicationRequest,
  ): Promise<HarnessProcessPublicationReconciliation>;
}

export interface HarnessProcessJoined {
  readonly invocationRpc: boolean;
  readonly fetch: boolean;
  readonly ports: boolean;
}

export interface HarnessProcessInvocationSettlement<Value = unknown> {
  readonly value: Value;
  readonly stopAcknowledged: boolean;
  readonly joined: HarnessProcessJoined;
}

export interface HarnessProcessObservedFacet {
  readonly facetNonce: string;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly manifestRevision: string;
  readonly joined: HarnessProcessJoined;
}

/** The stub is synchronous so the permit and facet identity can be claimed before any RPC. */
export interface HarnessProcessPreparedFacet<Input = unknown> {
  /** Reads state owned by the constructed facet instead of trusting a request echo. */
  identity(): Promise<{ readonly facetKey: string; readonly incarnationNonce: string }>;
  prepareInert(input: {
    readonly operationId: string;
    readonly targetFacetNonce: string;
    readonly nativeSessionId: string;
    readonly checkpointId: string;
    readonly manifestRevision: string;
    readonly priorFacetNonce: string;
    readonly expectedFacetGeneration: number;
  }): Promise<HarnessProcessObservedFacet>;
  activate(publication: HarnessProcessPublicationReceipt): Promise<void>;
  invoke(input: Input): Promise<HarnessProcessInvocationSettlement>;
  stop(): Promise<{ readonly acknowledged: boolean }>;
  join(): Promise<HarnessProcessJoined>;
  dispose(): Promise<void>;
}

export interface HarnessProcessPlacementRequest {
  readonly processId: string;
  readonly codeId: string;
  readonly residentBytes: number;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  /** The prior durable publisher's nonce, captured before preparing this process. */
  readonly priorFacetNonce: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly operationId: string;
  readonly expectedFacetGeneration: number;
  readonly signal: AbortSignal;
}

export interface HarnessProcessPlacementRecoveryRecord {
  readonly version: 1;
  readonly shardOwner: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly operationId: string;
  readonly processId: string;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly expectedFacetGeneration?: number;
  readonly programCodeId: string;
  readonly loaderId: string;
  readonly facetKey: string;
  readonly incarnationNonce?: string;
  readonly identityState?: "unknown" | "observed";
  readonly lease: ProcessSlotLease;
  readonly state:
    | "identity-unknown"
    | "preparing"
    | "prepared"
    | "publication-confirmed"
    | "active"
    | "parked"
    | "cleanup-required"
    | "activation-failed";
  readonly stopAcknowledged: boolean;
  readonly joined: HarnessProcessJoined;
  readonly publicationState?: "in-progress" | "unknown" | "pending" | "confirmed" | "not-published";
  readonly publicationReceipt?: HarnessProcessPublicationReceipt;
  readonly invocationMayHaveStarted?: boolean;
  readonly invocationRequestId?: string;
  readonly invocationReply?: "unresolved" | "received";
  readonly lastFailure?: HarnessProcessFailureRecord;
  /** Publication ownership stays sticky until a separate authorized repair accepts it. */
  readonly terminalFailure?: HarnessProcessFailureRecord;
}

export type HarnessProcessFailureStage =
  | "prepare"
  | "activation"
  | "invocation"
  | "stop"
  | "join"
  | "dispose"
  | "recovery";

export type HarnessProcessFailureCode =
  | "RPC_FAILED"
  | "IDENTITY_MISMATCH"
  | "STOP_UNACKNOWLEDGED"
  | "JOIN_INCOMPLETE"
  | "DISPOSE_FAILED"
  | "PUBLICATION_UNCONFIRMED"
  | "PUBLICATION_REQUIRES_REPAIR"
  | "INVOCATION_OUTCOME_UNKNOWN"
  | "RECOVERY_UNKNOWN";

export interface HarnessProcessFailureRecord {
  readonly stage: HarnessProcessFailureStage;
  readonly code: HarnessProcessFailureCode;
  readonly message: string;
}

export interface HarnessProcessPlacementRecoveryStore {
  list(): Promise<readonly HarnessProcessPlacementRecoveryRecord[]>;
  save(record: HarnessProcessPlacementRecoveryRecord): Promise<void>;
  remove(loaderId: string): Promise<void>;
}

export interface HarnessProcessPlacementOptions extends Omit<ProcessSlotsOptions, "inFlightLimit"> {
  /** Stable for this actual DO context or Worker request. Reuse the platform ctx object. */
  readonly contextKey: object;
  readonly context: HarnessProcessPlacementContext;
  /** Separate from the per-process constructor nonce in HarnessProcessPlacementIdentity. */
  readonly shardIncarnationNonce: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly recovery: HarnessProcessPlacementRecoveryStore;
  readonly onCapacity?: (
    pressure: Extract<ProcessSlotPressure, { readonly kind: "capacity" }>,
  ) => void;
  readonly onUnplaceable?: (
    request: ProcessSlotRequest,
    pressure: Extract<ProcessSlotPressure, { readonly kind: "unplaceable" }>,
  ) => void;
}

export interface HarnessProcessPlacement {
  readonly signals: ProcessSlotSignals;
  readonly shardOwner: string;
  readonly shardIncarnationNonce: string;
  prepareInert<Input = unknown>(
    request: HarnessProcessPlacementRequest,
    openFacet: (identity: HarnessProcessFacetLocator) => HarnessProcessPreparedFacet<Input>,
  ): Promise<HarnessProcessHandle<Input>>;
  recoverable(): Promise<readonly HarnessProcessPlacementRecoveryRecord[]>;
}

export interface HarnessProcessHandle<Input = unknown> {
  readonly identity: HarnessProcessPlacementIdentity;
  readonly lease: ProcessSlotLease;
  /** Persists publication-in-progress before calling the publisher exactly once. */
  activate(
    publisher: HarnessProcessPublicationPublisher,
  ): Promise<HarnessProcessPublishedActivation>;
  invoke(input: Input): Promise<HarnessProcessInvocationSettlement>;
  /** The returned promise resolves only after the wait completes and ProcessSlots re-admits. */
  park<Value>(
    waitForResume: () => Promise<{
      readonly value: Value;
      readonly publication: HarnessProcessPublication;
    }>,
    signal: AbortSignal,
  ): Promise<Value>;
  stop(): Promise<{ readonly acknowledged: boolean }>;
  join(): Promise<HarnessProcessJoined>;
  cleanup(options?: { readonly retainPublishedOwnership?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}

export class HarnessProcessPlacementError extends Error {
  readonly _tag = "HarnessProcessPlacementError";
  readonly kind:
    | "unplaceable"
    | "stale-publication"
    | "publication-unknown"
    | "prepare-failed"
    | "activation-failed"
    | "cleanup-incomplete"
    | "invocation-unsettled"
    | "shard-fenced"
    | "stale-handle";
  readonly recoverable: boolean;
  readonly identity: HarnessProcessPlacementIdentity | undefined;
  readonly details: HarnessProcessPlacementErrorDetails | undefined;

  constructor(
    kind: HarnessProcessPlacementError["kind"],
    message: string,
    recoverable: boolean,
    identity?: HarnessProcessPlacementIdentity,
    details?: HarnessProcessPlacementErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HarnessProcessPlacementError";
    this.kind = kind;
    this.recoverable = recoverable;
    this.identity = identity;
    this.details = details;
  }
}

export interface HarnessProcessPlacementErrorDetails {
  readonly recoveryId?: string;
  readonly route?: "different-destination-required";
  readonly residentBytes?: number;
  readonly openInvocations?: number;
  readonly expectedState?: HarnessProcessPlacementRecoveryRecord["state"];
  readonly actualState?: HarnessProcessPlacementRecoveryRecord["state"];
  readonly identityMismatch?: "facet-key" | "incarnation" | "native-session" | "checkpoint";
  readonly causeCode?: HarnessProcessFailureCode;
  readonly facetFailureAt?: "identity" | "prepare" | "persist" | "park";
  readonly publicationState?: "in-progress" | "unknown" | "pending" | "confirmed" | "not-published";
  readonly facetFailureCode?:
    | "type-error"
    | "range-error"
    | "syntax-error"
    | "rpc-not-found"
    | "rpc-error"
    | "unknown";
}

export type HarnessProcessPlacementProcessSlotsOptions = Omit<ProcessSlotsOptions, "inFlightLimit">;

export interface HarnessProcessPlacementAllocatorOptions {
  readonly processSlots: HarnessProcessPlacementProcessSlotsOptions;
  readonly contextKey: object;
  readonly context: HarnessProcessPlacementContext;
  readonly shardIncarnationNonce: string;
  readonly controllerClaim: HarnessProcessControllerClaim;
  readonly recovery: HarnessProcessPlacementRecoveryStore;
  readonly onCapacity?: HarnessProcessPlacementOptions["onCapacity"];
  readonly onUnplaceable?: HarnessProcessPlacementOptions["onUnplaceable"];
}

export type HarnessProcessPlacementStore = ProcessSlotStore;
export type HarnessProcessPermit = ProcessSlotPermit;
