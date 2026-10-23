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
  /** Commits before resolving. Aborts before publication roll back; later aborts may resolve a lease to release. */
  acquire(
    request: ProcessSlotRequest,
  ): Promise<{ lease: ProcessSlotLease; permit: ProcessSlotPermit }>;
  /** A rejected or aborted wait throws without re-admission. Its lease stays parked until retired. */
  park<T>(
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    waitFor: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<{ value: T; permit: ProcessSlotPermit }>;
  /** The caller serializes the continuation and obtains the actual stop acknowledgement first. */
  handoff(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void>;
  /** Keeps the latest measurement in memory; the next state-changing operation persists it. */
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
  /** Latched until this allocator is replaced by recovery. */
  readonly fenced: boolean;
  onFenced(listener: (error: unknown) => void): () => void;
  /** Capacity repeats each quantum; unplaceable work is reported once until it fits or leaves. */
  onPressure(listener: (state: ProcessSlotPressure) => void): () => void;
}

export type ProcessSlotBlocker =
  | { readonly kind: "capacity" }
  | { readonly kind: "unplaceable"; readonly request: ProcessSlotRequest }
  | { readonly kind: "unplaceable"; readonly lease: ProcessSlotLease };

/** Capacity can be added by a shard; unplaceable work needs a different execution destination. */
export type ProcessSlotPressure = ProcessSlotBlocker & {
  readonly inFlight: number;
  readonly resident: number;
  readonly waiting: number;
};

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
      /** A committed loss survives a later failure while retiring the generation. */
      readonly lost?: "memory" | "isolate";
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
  readonly inFlightLimit: number;
  /** Total process residency in each slot isolate, including gateway buffers and module caches. */
  readonly residentByteLimit: number;
  readonly store: ProcessSlotStore;
  /** The supervisor drives scheduling quanta; cancellation removes the scheduled callback. */
  readonly scheduleQuantum: (callback: () => void) => () => void;
  /** Idempotent eviction runs inside the serial queue and must not call back into ProcessSlots. */
  readonly invalidate: (loaderId: string) => void | Promise<void>;
  readonly recoveryConcurrency?: number;
  /**
   * Recovery completes before admission opens. A stop requires actual acknowledgement.
   * Report lost unless the stub is proven healthy; a failed loss save may leave no durable marker.
   */
  readonly reconcile: (
    lease: ProcessSlotLease,
  ) => Promise<{ readonly acknowledged: true } | { readonly lost: "memory" | "isolate" }>;
}
