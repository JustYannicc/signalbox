import { RpcTarget } from "cloudflare:workers";
import { createKernelGitHost } from "../kernel/KernelGitHost.ts";
import type { KernelGitCall, KernelGitCallResult, KernelGitPort } from "../kernel/KernelGitPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

class WorkerGitPort extends RpcTarget implements KernelGitPort {
  readonly #port: ChildHostRef<KernelGitPort>;

  constructor(port: ChildHostRef<KernelGitPort>) {
    super();
    this.#port = port;
  }

  async call(request: KernelSyscallRequest) {
    return this.#port.get().call(request);
  }

  async callGit(request: KernelGitCall): Promise<KernelGitCallResult> {
    return this.#port.get().callGit(request);
  }
}

/** Passes only the admitted process's Git and WASI callbacks to the child worker. */
export function createWorkerGitHost(
  options: { readonly context: KernelAsyncProgramContext },
  lease: ChildHostLease,
) {
  const owner = createKernelGitHost(options);
  return { host: new WorkerGitPort(lease.hold(owner.port)), close: owner.close };
}
