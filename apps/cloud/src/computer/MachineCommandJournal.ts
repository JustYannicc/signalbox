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
}

/** Persist each transition before its external action. An interrupted execute is never replayed. */
export interface MachineCommandJournal {
  readonly write: (record: MachineCommandRecord) => Promise<void>;
}
