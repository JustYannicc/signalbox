import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import { createChildWorkerProgram, type ChildWorkerProgramOptions } from "./ChildWorkerProgram.ts";
import { createWorkerBusyboxHost } from "./WorkerBusyboxHost.ts";

export type ChildBusyboxProgramOptions = Omit<
  ChildWorkerProgramOptions<KernelBusyboxPort>,
  "createHost"
>;

/** Source modules and WASM bytes pass straight to the existing shared child admission path. */
export function createChildBusyboxProgram(options: ChildBusyboxProgramOptions) {
  return createChildWorkerProgram({
    ...options,
    createHost: (context, lease) => createWorkerBusyboxHost({ context }, lease),
  });
}
