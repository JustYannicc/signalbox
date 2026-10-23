import { RpcTarget } from "cloudflare:workers";
import { createKernelCoreutilsHost } from "../kernel/KernelCoreutilsHost.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCoreutilsCall, KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

class WorkerCoreutilsPort extends RpcTarget implements KernelCoreutilsPort {
  readonly #port: ChildHostRef<KernelCoreutilsPort>;

  constructor(port: ChildHostRef<KernelCoreutilsPort>) {
    super();
    this.#port = port;
  }

  async call(request: Parameters<KernelCoreutilsPort["call"]>[0]) {
    return this.#port.get().call(request);
  }

  async callCoreutils(request: KernelCoreutilsCall) {
    return this.#port.get().callCoreutils(request);
  }
}

/** Keeps the shared process port as an RPC capability across the Dynamic Worker boundary. */
export function createWorkerCoreutilsHost(
  options: { readonly context: KernelAsyncProgramContext },
  lease: ChildHostLease,
) {
  const owner = createKernelCoreutilsHost(options);
  return {
    host: new WorkerCoreutilsPort(lease.hold(owner.port)),
    ready: owner.ready,
    close: owner.close,
  };
}
