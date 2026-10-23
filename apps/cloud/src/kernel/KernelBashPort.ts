import type { KernelExitStatus } from "./KernelProcessTable.ts";
import type { KernelBashForkSource } from "./KernelBashFork.ts";
import type { KernelSyscallPort } from "./KernelSyscallPort.ts";
import type {
  KernelBashAdmissionFailure,
  KernelBashCall,
  KernelBashCallResult,
  KernelBashCompletion,
  KernelBashExecRequest,
  KernelBashExecResult,
  KernelBashOperation,
  KernelBashOperationEffect,
  KernelBashOperationResult,
  KernelBashOperationStart,
  KernelBashWaitResult,
} from "./KernelBashCheckpoint.ts";

export type {
  KernelBashAdmissionFailure,
  KernelBashCall,
  KernelBashCallResult,
  KernelBashCompletion,
  KernelBashExecRequest,
  KernelBashExecResult,
  KernelBashOperation,
  KernelBashOperationEffect,
  KernelBashOperationResult,
  KernelBashOperationStart,
  KernelBashWaitResult,
} from "./KernelBashCheckpoint.ts";

/** Each port is bound to one live process; callers cannot select another PID's resources. */
export interface KernelBashPort extends Pick<KernelSyscallPort, "call"> {
  runFork(source: KernelBashForkSource): Promise<KernelExitStatus>;
  /** New Worker bridge: begin a syscall once and expose waits without holding the child RPC. */
  startOperation?(operation: KernelBashOperation): Promise<KernelBashOperationStart>;
  /** Persist this process's continuation; its loader lease moves only after stop acknowledgement. */
  park?(source: KernelBashForkSource, operationId?: string): Promise<void>;
  /** Place an already-created fork child from the saved parent image. */
  placeFork?(source: KernelBashForkSource): Promise<void>;
  /** Aggregate current reactor WebAssembly bytes, excluding Worker and host overhead. */
  observeResident?(bytes: number): void | Promise<void>;
  callBash(request: KernelBashCall): Promise<KernelBashCallResult>;
  fork(): Promise<
    | { readonly kind: "fork"; readonly pid: number; readonly port: KernelBashPort }
    | KernelBashAdmissionFailure
  >;
  wait(pid: number, options: number): Promise<KernelBashWaitResult>;
  exec(request: KernelBashExecRequest): Promise<KernelBashExecResult>;
  complete(result: KernelBashCompletion): Promise<void>;
}
