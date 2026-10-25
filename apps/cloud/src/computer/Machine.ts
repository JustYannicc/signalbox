import type * as Option from "effect/Option";
import type { BaseLease, DriveRef, RecipeHash } from "./Computer.ts";

export type MachineCreationDisposition = "not_created" | "unknown";

/** Lets a caller release a Base only when creation is known not to have persisted. */
export class MachineCreationError extends Error {
  readonly _tag = "MachineCreationError";
  readonly disposition: MachineCreationDisposition;

  constructor(disposition: MachineCreationDisposition, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MachineCreationError";
    this.disposition = disposition;
  }
}

export interface MachineHandle {
  readonly id: string;
  readonly generation: number;
  readonly release: () => Promise<void>;
}

export interface MachineCreateInput {
  readonly operationId: string;
  readonly drive: DriveRef;
  readonly recipeHash: RecipeHash;
  readonly base: Option.Option<BaseLease>;
  /** Absolute epoch milliseconds; with a Base lease this equals lease.expiresAt. */
  readonly expiresAt: number;
}

export interface MachineOwnershipAttestation {
  readonly operationId: string;
  readonly machineId: string;
  readonly generation: number;
}

export interface MachineAbsenceAttestation {
  readonly operationId: string;
  readonly reservationId: string | null;
  readonly name: string | null;
  readonly generation: number | null;
  readonly machineId: string | null;
  readonly createStarted: boolean;
  readonly reservationReleased: boolean;
  readonly providerAbsent: true;
}

export type MachineReconciliation =
  | {
      readonly status: "owned";
      readonly handle: MachineHandle;
      readonly ownership: MachineOwnershipAttestation;
    }
  | {
      readonly status: "absent";
      readonly absence: MachineAbsenceAttestation;
      /** Tombstone an exact, provider-absent reservation. Does not create or reserve. */
      readonly releaseReservation: () => Promise<void>;
    }
  | { readonly status: "unknown" };

export interface Machine {
  readonly create: (input: MachineCreateInput, signal: AbortSignal) => Promise<MachineHandle>;
  /** Lookup-only recovery. Implementations must never dispatch create or fork here. */
  readonly reconcile: (
    input: MachineCreateInput,
    signal: AbortSignal,
  ) => Promise<MachineReconciliation>;
}
