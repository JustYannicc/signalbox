import { RpcTarget } from "cloudflare:workers";
import { createKernelCoreutilsHost } from "../kernel/KernelCoreutilsHost.ts";
import type { KernelAsyncProgramContext } from "../kernel/KernelAsyncProgram.ts";
import type { KernelCoreutilsCall, KernelCoreutilsPort } from "../kernel/KernelCoreutilsPort.ts";

class WorkerCoreutilsPort extends RpcTarget implements KernelCoreutilsPort {
  readonly #port: KernelCoreutilsPort;

  constructor(port: KernelCoreutilsPort) {
    super();
    this.#port = port;
  }

  call(request: Parameters<KernelCoreutilsPort["call"]>[0]) {
    return this.#port.call(request);
  }

  callCoreutils(request: KernelCoreutilsCall) {
    return this.#port.callCoreutils(request);
  }
}

/** Keeps the shared process port as an RPC capability across the Dynamic Worker boundary. */
export function createWorkerCoreutilsHost(options: {
  readonly context: KernelAsyncProgramContext;
}) {
  const owner = createKernelCoreutilsHost(options);
  return { host: new WorkerCoreutilsPort(owner.port), close: owner.close };
}
