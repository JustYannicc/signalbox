import { RpcTarget } from "cloudflare:workers";
import { createKernelGitHost } from "../kernel/KernelGitHost.ts";
import type { KernelGitCall, KernelGitCallResult, KernelGitPort } from "../kernel/KernelGitPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";

class WorkerGitPort extends RpcTarget implements KernelGitPort {
  readonly #port: KernelGitPort;

  constructor(port: KernelGitPort) {
    super();
    this.#port = port;
  }

  call(request: KernelSyscallRequest) {
    return this.#port.call(request);
  }

  callGit(request: KernelGitCall): Promise<KernelGitCallResult> {
    return this.#port.callGit(request);
  }
}

/** Passes only the admitted process's Git and WASI callbacks to the child worker. */
export function createWorkerGitHost(options: { readonly context: KernelAsyncProgramContext }) {
  const owner = createKernelGitHost(options);
  return {
    host: new WorkerGitPort(owner.port),
    close: owner.close,
  };
}
