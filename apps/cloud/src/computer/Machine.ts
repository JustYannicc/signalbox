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

export interface Machine {
  readonly create: (
    input: {
      readonly operationId: string;
      readonly drive: DriveRef;
      readonly recipeHash: RecipeHash;
      readonly base: Option.Option<BaseLease>;
      /** Absolute epoch milliseconds; with a Base lease this equals lease.expiresAt. */
      readonly expiresAt: number;
    },
    signal: AbortSignal,
  ) => Promise<MachineHandle>;
}
