import { RpcTarget } from "cloudflare:workers";
import { createKernelCoreutilsHost } from "../kernel/KernelCoreutilsHost.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCoreutilsCall, KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";

class WorkerCoreutilsPort extends RpcTarget implements KernelCoreutilsPort {
  readonly #port: ChildHostRef<KernelCoreutilsPort>;
  readonly #lease: ChildHostLease;

  constructor(port: ChildHostRef<KernelCoreutilsPort>, lease: ChildHostLease) {
    super();
    this.#port = port;
    this.#lease = lease;
  }

  async call(request: Parameters<KernelCoreutilsPort["call"]>[0]) {
    this.#lease.observe(request.memorySize);
    return this.#port.get().call(request);
  }

  async callCoreutils(request: KernelCoreutilsCall) {
    this.#lease.observe(request.memorySize);
    return this.#port.get().callCoreutils(request);
  }
}

/** Keeps the shared process port as an RPC capability across the Dynamic Worker boundary. */
export function createWorkerCoreutilsHost(
  options: { readonly context: KernelAsyncProgramContext },
  lease: ChildHostLease,
) {
  const owner = createKernelCoreutilsHost(options);
  return { host: new WorkerCoreutilsPort(lease.hold(owner.port), lease), close: owner.close };
}
