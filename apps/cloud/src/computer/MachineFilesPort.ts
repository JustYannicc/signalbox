import type {
  MachineFileOperation,
  MachineFileOperationResult,
} from "@signalbox/runner-protocol/MachineFilesProtocol";

export interface MachineFileSourceState {
  readonly generation: number | null;
  /** Immutable image attested by the lifecycle owner; unknown images use live lookup. */
  readonly imageDigest?: string;
  /** True only when lifecycle state attests that this image has run no machine command. */
  readonly pristine: boolean;
}

export interface MachineFileSourceAttestation {
  /** Read from the machine lifecycle owner, shared across Computer reopen. */
  readonly current: () => MachineFileSourceState | null;
  /** Persist the idempotent dirty transition before the first command is sent to this generation. */
  readonly markExecuted: (generation: number) => void | Promise<void>;
}

export interface MachineFileLookupInput {
  readonly generation: number;
  readonly operations: ReadonlyArray<MachineFileOperation>;
}

export interface MachineFileLookupResponse {
  readonly generation: number;
  readonly results: ReadonlyArray<MachineFileOperationResult>;
}

export type MachineFileLookupErrorCode =
  | "BACKEND_UPGRADE_REQUIRED"
  | "RUNNER_NOT_READY"
  | "RUNNER_DISCONNECTED"
  | "STALE_GENERATION"
  | "REQUEST_TIMEOUT"
  | "FRAME_TOO_LARGE"
  | "INVALID_REQUEST"
  | "LOOKUP_FAILED"
  | "ABORTED"
  | "DISPOSED";

export class MachineFileLookupError extends Error {
  readonly code: MachineFileLookupErrorCode;

  constructor(code: MachineFileLookupErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MachineFileLookupError";
    this.code = code;
  }
}

/** Read-only machine filesystem access on the generation named by `current()`. */
export interface MachineFilesPort {
  /** Missing or untrusted lifecycle attestation is returned as pristine false. */
  readonly current: () => MachineFileSourceState;
  /** Persist the dirty transition before any machine command is sent. */
  readonly markExecuted: (generation: number) => Promise<void>;
  readonly lookup: (
    input: MachineFileLookupInput,
    signal: AbortSignal,
  ) => Promise<MachineFileLookupResponse>;
}
