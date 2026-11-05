import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelCommandExit } from "./KernelCommandForwarder.ts";
import type { KernelBashWorkerPort } from "./KernelBashDispatchPort.ts";
import type { ChildHostLease } from "./KernelDispatchLease.ts";

export interface KernelWorkerExecution {
  readonly residentByteLimit: number;
  handoff(): Promise<void>;
}

export interface KernelBashWorkerRunner {
  run(
    context: KernelAsyncProgramContext,
    createHost: (
      context: KernelAsyncProgramContext,
      lease: ChildHostLease,
      execution: KernelWorkerExecution,
    ) => {
      readonly host: KernelBashWorkerPort;
      readonly close: () => Promise<void> | void;
      readonly onDispatchFailure?: (error: unknown) => Promise<void> | void;
      readonly onStopped?: () => Promise<void> | void;
    },
    initialResidentBytes?: number,
  ): Promise<KernelCommandExit>;
}
