import type { KernelBashPort } from "./KernelBashPort.ts";
import type { KernelCommand, KernelCommandExit } from "./KernelCommandForwarder.ts";
import type { KernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelWorkerFailure } from "./KernelWorkerFailure.ts";

export interface KernelBashWorkerPort extends KernelBashPort {
  metadata(): Promise<unknown> | unknown;
  forkSnapshot():
    | Promise<import("./KernelBashFork.ts").KernelBashForkSource | undefined>
    | import("./KernelBashFork.ts").KernelBashForkSource
    | undefined;
}

export interface KernelBashPhaseExecution {
  handoff(): Promise<void>;
}

export interface KernelBashPhasePort {
  describe(): Promise<{
    readonly command: KernelCommand;
    readonly requester: KernelProcessAdmissionPort;
  }>;
  open(
    residentByteLimit: number,
    execution: KernelBashPhaseExecution,
  ): Promise<KernelBashWorkerPort>;
  aborted(): Promise<{ readonly aborted: boolean; readonly reason?: unknown }>;
  failure(failure: KernelWorkerFailure): Promise<void>;
  revoke(): Promise<void>;
  stopped(): Promise<void>;
}

export type KernelWorkerDispatchResult =
  | { readonly ok: true; readonly exit: KernelCommandExit }
  | { readonly ok: false; readonly failure: KernelWorkerFailure };

export interface KernelBashDispatcher {
  run(
    phase: KernelBashPhasePort,
    initial: boolean,
    residentBytes: number,
  ): Promise<KernelWorkerDispatchResult>;
  finished(): Promise<void>;
}
