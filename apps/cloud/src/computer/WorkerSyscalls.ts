import { RpcTarget } from "cloudflare:workers";
import {
  createKernelSyscallHost,
  type KernelSyscallHostOptions,
} from "../kernel/KernelSyscallHost.ts";
import type { KernelSyscallPort, KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

/** The child receives syscall capability for its own prepared kernel process only. */
export class WorkerSyscalls extends RpcTarget implements KernelSyscallPort {
  readonly #host: ChildHostRef<KernelSyscallPort>;
  readonly #lease: ChildHostLease;

  constructor(host: ChildHostRef<KernelSyscallPort>, lease: ChildHostLease) {
    super();
    this.#host = host;
    this.#lease = lease;
  }

  async call(request: KernelSyscallRequest) {
    this.#lease.observe(request.memorySize);
    return this.#host.get().call(request);
  }
}

export function createWorkerSyscalls(options: KernelSyscallHostOptions, lease: ChildHostLease) {
  const owner = createKernelSyscallHost(options);
  return { host: new WorkerSyscalls(lease.hold(owner), lease), close: owner.close };
}
