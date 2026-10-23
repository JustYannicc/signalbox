import { RpcTarget } from "cloudflare:workers";
import { createKernelBusyboxHost } from "../kernel/KernelBusyboxHost.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type {
  KernelBusyboxCall,
  KernelBusyboxCallResult,
  KernelBusyboxPort,
} from "../kernel/KernelBusyboxPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

class WorkerBusyboxPort extends RpcTarget implements KernelBusyboxPort {
  readonly #port: ChildHostRef<KernelBusyboxPort>;

  constructor(port: ChildHostRef<KernelBusyboxPort>) {
    super();
    this.#port = port;
  }

  async call(request: KernelSyscallRequest) {
    return this.#port.get().call(request);
  }

  async callBusybox(request: KernelBusyboxCall): Promise<KernelBusyboxCallResult> {
    return this.#port.get().callBusybox(request);
  }
}

/** Passes only the admitted process's BusyBox and WASI callbacks to the child worker. */
export function createWorkerBusyboxHost(
  options: { readonly context: KernelAsyncProgramContext },
  lease: ChildHostLease,
) {
  const owner = createKernelBusyboxHost(options);
  return {
    host: new WorkerBusyboxPort(lease.hold(owner.port)),
    close: owner.close,
  };
}
