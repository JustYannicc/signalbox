import { createKernelBusyboxHost } from "../kernel/KernelBusyboxHost.ts";
import type { KernelBusyboxPort } from "../kernel/KernelBusyboxPort.ts";
import { createChildWorkerProgram, type ChildWorkerProgramOptions } from "./ChildWorkerProgram.ts";

export interface ChildBusyboxProgramOptions<Host extends object> extends Omit<
  ChildWorkerProgramOptions<Host>,
  "createHost"
> {
  readonly parentRpcTarget: (port: KernelBusyboxPort) => Host;
}

/** Source modules and WASM bytes pass straight to the existing shared child admission path. */
export function createChildBusyboxProgram<Host extends object>(
  options: ChildBusyboxProgramOptions<Host>,
) {
  return createChildWorkerProgram({
    ...options,
    createHost(context) {
      const owner = createKernelBusyboxHost({ context });
      try {
        return { host: options.parentRpcTarget(owner.port), close: owner.close };
      } catch (error) {
        void owner.close();
        throw error;
      }
    },
  });
}
