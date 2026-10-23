import type {
  ProcessSlotLease,
  ProcessSlotPermit,
  ProcessSlotPressure,
  ProcessSlotRequest,
  ProcessSlotSignals,
  ProcessSlotsOptions,
  ProcessSlotStore,
} from "../../computer/ProcessSlots.ts";

export type HarnessProcessPlacementContext = "durable-object" | "worker-request";

export interface HarnessProcessPlacementIdentity {
  readonly shardOwner: string;
  readonly loaderId: string;
  readonly facetKey: string;
  readonly incarnationNonce: string;
}

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
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly facetKey: string;
  readonly incarnationNonce: string;
  readonly joined: HarnessProcessJoined;
}

/** The stub is synchronous. All resource-opening work starts in prepareInert(). */
export interface HarnessProcessPreparedFacet<Input = unknown> {
  prepareInert(input: {
    readonly identity: HarnessProcessPlacementIdentity;
    readonly operationId: string;
    readonly nativeSessionId: string;
    readonly checkpointId: string;
    readonly manifestRevision: string;
  }): Promise<HarnessProcessObservedFacet>;
  activate(publication: HarnessProcessPublicationReceipt): Promise<void>;
  invoke(input: Input): Promise<HarnessProcessInvocationSettlement>;
  stop(): Promise<{ readonly acknowledged: boolean }>;
  join(): Promise<HarnessProcessJoined>;
  dispose(): Promise<void>;
}

export interface HarnessProcessPlacementRequest {
  readonly codeId: string;
  readonly residentBytes: number;
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  /** The prior durable publisher's nonce, captured before preparing this process. */
  readonly priorFacetNonce: string;
  readonly preparedFacetNonce: string;
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
  readonly nativeSessionId: string;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly priorFacetNonce: string;
  readonly programCodeId: string;
  readonly loaderId: string;
  readonly facetKey: string;
  readonly incarnationNonce: string;
  readonly lease: ProcessSlotLease;
  readonly state:
    | "preparing"
    | "prepared"
    | "active"
    | "parked"
    | "cleanup-required"
    | "activation-failed";
  readonly stopAcknowledged: boolean;
  readonly joined: HarnessProcessJoined;
  readonly lastFailure?: string;
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
    openFacet: (identity: HarnessProcessPlacementIdentity) => HarnessProcessPreparedFacet<Input>,
  ): Promise<HarnessProcessHandle<Input>>;
  recoverable(): Promise<readonly HarnessProcessPlacementRecoveryRecord[]>;
}

export interface HarnessProcessHandle<Input = unknown> {
  readonly identity: HarnessProcessPlacementIdentity;
  readonly lease: ProcessSlotLease;
  activate(
    publication: HarnessProcessPublication | Promise<HarnessProcessPublication>,
  ): Promise<void>;
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
  cleanup(): Promise<void>;
  dispose(): Promise<void>;
}

export class HarnessProcessPlacementError extends Error {
  readonly _tag = "HarnessProcessPlacementError";
  readonly kind:
    | "unplaceable"
    | "stale-publication"
    | "prepare-failed"
    | "activation-failed"
    | "cleanup-incomplete"
    | "invocation-unsettled"
    | "shard-fenced"
    | "stale-handle";
  readonly recoverable: boolean;
  readonly identity: HarnessProcessPlacementIdentity | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    kind: HarnessProcessPlacementError["kind"],
    message: string,
    recoverable: boolean,
    identity?: HarnessProcessPlacementIdentity,
    details?: Readonly<Record<string, unknown>>,
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
