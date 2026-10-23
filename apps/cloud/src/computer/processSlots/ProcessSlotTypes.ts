declare const leaseToken: unique symbol;
export type ProcessSlotLeaseToken = string & { readonly [leaseToken]: true };

export interface ProcessSlotLease {
  readonly token: ProcessSlotLeaseToken;
  readonly loaderId: string;
  readonly codeId: string;
  readonly residentBytes: number;
}

export interface ProcessSlotRequest {
  readonly owner: string;
  readonly codeId: string;
  readonly residentBytes: number;
  readonly signal: AbortSignal;
}

export interface ProcessSlotPermit {
  readonly token: ProcessSlotLeaseToken;
}

export interface ProcessSlots {
  /** Commits the lease and permit before resolving; only capacity waits. */
  acquire(
    request: ProcessSlotRequest,
  ): Promise<{ lease: ProcessSlotLease; permit: ProcessSlotPermit }>;
  /** Abort keeps the resident lease. A failed wait re-admits before throwing, preserving the permit. */
  park<T>(
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    waitFor: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<{ value: T; permit: ProcessSlotPermit }>;
  /** The caller serializes the continuation and obtains the actual stop acknowledgement first. */
  handoff(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void>;
  /** Saves are ordered before subsequent async operations; a failed save fences them until recovery. */
  observe(lease: ProcessSlotLease, residentBytes: number): void;
  release(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void>;
  lose(lease: ProcessSlotLease, reason: "memory" | "isolate"): Promise<void>;
  readonly signals: ProcessSlotSignals;
}

export interface ProcessSlotSignals {
  readonly inFlight: number;
  readonly resident: number;
  readonly waiting: number;
  readonly lost: number;
  onPressure(
    listener: (state: { inFlight: number; resident: number; waiting: number }) => void,
  ): () => void;
}

export interface ProcessSlotState {
  readonly version: 1;
  readonly owner: string;
  readonly lost: number;
  readonly slots: readonly {
    readonly codeId: string;
    readonly index: number;
    readonly generation: number;
    /** Retry stub eviction after recovery if loss was committed before invalidation finished. */
    readonly invalidating?: number;
    readonly holder?: {
      readonly token: ProcessSlotLeaseToken;
      readonly residentBytes: number;
      readonly permitted: boolean;
    };
  }[];
}

/** One supervisor-owned writer per shard. */
export interface ProcessSlotStore {
  load(): Promise<ProcessSlotState | undefined>;
  /** A rejected save must leave the previous committed state intact. */
  save(state: ProcessSlotState): Promise<void>;
}

export interface ProcessSlotsOptions {
  readonly owner: string;
  readonly ioContext: "durable-object" | "worker-request";
  /** Total process residency in each slot isolate, including gateway buffers and module caches. */
  readonly residentByteLimit: number;
  readonly store: ProcessSlotStore;
  /** The supervisor drives scheduling quanta; cancellation removes the scheduled callback. */
  readonly scheduleQuantum: (callback: () => void) => () => void;
  /** Idempotent eviction of the cached stub, including retries after recovery. */
  readonly invalidate: (loaderId: string) => void | Promise<void>;
  /** Recovery completes before admission opens. Never infer a stop from a missing RPC. */
  readonly reconcile: (
    lease: ProcessSlotLease,
  ) => Promise<{ readonly acknowledged: true } | { readonly lost: "memory" | "isolate" }>;
}
