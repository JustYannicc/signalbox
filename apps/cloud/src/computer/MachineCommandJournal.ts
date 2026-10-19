import type { BaseLease } from "./Computer.ts";
import type { ForkCommit } from "../kernel/FilePersistencePorts.ts";

export interface MachineCommandRecord {
  readonly operationId: string;
  readonly phase:
    | "checkpoint"
    | "create"
    | "prepare"
    | "execute"
    | "commit"
    | "apply"
    | "delete"
    | "complete";
  readonly before?: ForkCommit;
  readonly after?: ForkCommit;
  readonly machine?: { readonly id: string; readonly generation: number };
  readonly base?: BaseLease;
  readonly settled?: {
    readonly operationId: string;
    readonly machineId: string;
    readonly generation: number;
    readonly closed: true;
  };
  /** JSON-safe copy of every value passed to Machine.create, persisted before that call. */
  readonly createInput?: {
    readonly operationId: string;
    readonly drive: string;
    readonly recipeHash: string;
    readonly base: BaseLease | null;
    readonly expiresAt: number;
  };
}

/** Persist each transition before its external action. An interrupted execute is never replayed. */
export interface MachineCommandJournal {
  readonly write: (record: MachineCommandRecord) => Promise<void>;
  readonly read: (operationId: string) => MachineCommandRecord | undefined;
  /** Lists every non-complete row for the startup admission barrier. */
  readonly pending: () => readonly MachineCommandRecord[];
}
