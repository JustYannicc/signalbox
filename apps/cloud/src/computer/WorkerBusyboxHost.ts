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
  readonly #lease: ChildHostLease;

  constructor(port: ChildHostRef<KernelBusyboxPort>, lease: ChildHostLease) {
    super();
    this.#port = port;
    this.#lease = lease;
  }

  async call(request: KernelSyscallRequest) {
    this.#lease.observe(request.memorySize);
    return this.#port.get().call(request);
  }

  async callBusybox(request: KernelBusyboxCall): Promise<KernelBusyboxCallResult> {
    this.#lease.observe(request.memorySize);
    return this.#port.get().callBusybox(request);
  }
}

/** Passes only the admitted process's BusyBox and WASI callbacks to the child worker. */
export function createWorkerBusyboxHost(
  options: { readonly context: KernelAsyncProgramContext },
  lease: ChildHostLease,
) {
  const owner = createKernelBusyboxHost(options);
  return { host: new WorkerBusyboxPort(lease.hold(owner.port), lease), close: owner.close };
}
