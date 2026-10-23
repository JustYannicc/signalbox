import type { KernelExitStatus } from "./KernelProcessTable.ts";
import type {
  KernelMemoryRegion,
  KernelSyscallRequest,
  KernelSyscallResponse,
} from "./KernelSyscallPort.ts";

export interface KernelBashCall extends KernelSyscallRequest {
  readonly namespace: "nimbus_proc" | "env";
  readonly args: readonly number[];
}

export interface KernelBashCallResult {
  readonly value: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export type KernelBashCompletion =
  | { readonly kind: "exit"; readonly status: KernelExitStatus }
  | { readonly kind: "failure"; readonly message: string };

export type KernelBashAdmissionFailure = { readonly kind: "error"; readonly errno: number };

export type KernelBashWaitResult =
  | { readonly kind: "wait"; readonly pid: number; readonly status?: KernelExitStatus }
  | KernelBashAdmissionFailure;

export interface KernelBashExecRequest {
  readonly path: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export type KernelBashExecResult =
  | (KernelBashCompletion & { readonly kind: "exit" })
  | KernelBashAdmissionFailure;

/** A syscall request captured at the Asyncify boundary. */
export type KernelBashOperation =
  | { readonly kind: "wasi"; readonly request: KernelSyscallRequest }
  | { readonly kind: "bash"; readonly request: KernelBashCall }
  | { readonly kind: "wait"; readonly pid: number; readonly options: number }
  | { readonly kind: "exec"; readonly request: KernelBashExecRequest };

/** The normal port result. The outer kind makes restored results easy to validate. */
export type KernelBashOperationResult =
  | { readonly kind: "wasi"; readonly value: KernelSyscallResponse }
  | { readonly kind: "bash"; readonly value: KernelBashCallResult }
  | { readonly kind: "wait"; readonly value: KernelBashWaitResult }
  | { readonly kind: "exec"; readonly value: KernelBashExecResult };

export type KernelBashOperationStart =
  | { readonly kind: "ready"; readonly result: KernelBashOperationResult }
  | { readonly kind: "pending"; readonly id: string };

export interface KernelBashImportCall {
  readonly namespace: "wasi_snapshot_preview1" | "wasi_unstable" | "nimbus_proc" | "env";
  readonly name: string;
  readonly args: readonly (number | bigint)[];
}

export type KernelBashCheckpointPending =
  | {
      readonly kind: "operation";
      readonly operation: KernelBashOperation;
      readonly call: KernelBashImportCall;
    }
  | {
      readonly kind: "fork";
      /** parent resumes the syscall; child returns zero from an already-created fork. */
      readonly role: "parent" | "child";
      readonly call: KernelBashImportCall;
    };

/** Host-only values needed to land the exact unwound import after restoring linear memory. */
export interface KernelBashCheckpointContinuation {
  readonly resume: number;
  readonly pending?: KernelBashCheckpointPending;
  readonly operationId?: string;
  readonly result?: KernelBashOperationResult;
}

export type KernelBashOperationEffect =
  | { readonly kind: "resume"; readonly value: number }
  | { readonly kind: "continue"; readonly operation: KernelBashOperation }
  | { readonly kind: "exit"; readonly status: KernelExitStatus };

export interface BashAsyncifyOperationHooks {
  /** Called by synchronous WASM imports; it records the call and starts Asyncify unwind. */
  readonly suspend: (operation: KernelBashOperation, call: KernelBashImportCall) => number;
  /** Stops a rewind when the saved import is reached and returns its prepared result. */
  readonly landing: () => number | undefined;
}
