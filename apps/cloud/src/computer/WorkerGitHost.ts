import { RpcTarget } from "cloudflare:workers";
import { createKernelGitHost } from "../kernel/KernelGitHost.ts";
import type { KernelGitCall, KernelGitCallResult, KernelGitPort } from "../kernel/KernelGitPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

class WorkerGitPort extends RpcTarget implements KernelGitPort {
  readonly #port: ChildHostRef<KernelGitPort>;
  readonly #lease: ChildHostLease;

  constructor(port: ChildHostRef<KernelGitPort>, lease: ChildHostLease) {
    super();
    this.#port = port;
    this.#lease = lease;
  }

  async call(request: KernelSyscallRequest) {
    this.#lease.observe(request.memorySize);
    return this.#port.get().call(request);
  }

  async callGit(request: KernelGitCall): Promise<KernelGitCallResult> {
    this.#lease.observe(request.memorySize);
    return this.#port.get().callGit(request);
  }
}

/** Passes only the admitted process's Git and WASI callbacks to the child worker. */
export function createWorkerGitHost(
  options: { readonly context: KernelAsyncProgramContext },
  lease: ChildHostLease,
) {
  const owner = createKernelGitHost(options);
  return { host: new WorkerGitPort(lease.hold(owner.port), lease), close: owner.close };
}
