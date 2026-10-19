import { RpcTarget } from "cloudflare:workers";
import {
  createKernelSyscallHost,
  type KernelSyscallHostOptions,
} from "../kernel/KernelSyscallHost.ts";
import type { KernelSyscallPort, KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";

/** The child receives syscall capability for its own prepared kernel process only. */
export class WorkerSyscalls extends RpcTarget implements KernelSyscallPort {
  readonly #host: KernelSyscallPort;

  constructor(host: KernelSyscallPort) {
    super();
    this.#host = host;
  }

  call(request: KernelSyscallRequest) {
    return this.#host.call(request);
  }
}

export function createWorkerSyscalls(options: KernelSyscallHostOptions) {
  const owner = createKernelSyscallHost(options);
  return { host: new WorkerSyscalls(owner), close: owner.close };
}
