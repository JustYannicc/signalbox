import { RpcTarget } from "cloudflare:workers";
import { createKernelBashHost, type KernelBashHostOptions } from "../kernel/KernelBashHost.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type {
  KernelBashCall,
  KernelBashCompletion,
  KernelBashPort,
} from "../kernel/KernelBashPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";

class WorkerBashPort extends RpcTarget implements KernelBashPort {
  readonly #port: KernelBashPort;
  readonly #pid: number;
  readonly #credentials: KernelBashCredentials;

  constructor(port: KernelBashPort, pid: number, credentials: KernelBashCredentials) {
    super();
    this.#port = port;
    this.#pid = pid;
    this.#credentials = credentials;
  }

  metadata() {
    return { pid: this.#pid, credentials: { ...this.#credentials } };
  }

  call(request: KernelSyscallRequest) {
    return this.#port.call(request);
  }

  callBash(request: KernelBashCall) {
    return this.#port.callBash(request);
  }

  async fork() {
    const result = await this.#port.fork();
    return result.kind === "fork"
      ? { ...result, port: new WorkerBashPort(result.port, result.pid, this.#credentials) }
      : result;
  }

  wait(pid: number, options: number) {
    return this.#port.wait(pid, options);
  }

  exec(request: Parameters<KernelBashPort["exec"]>[0]) {
    return this.#port.exec(request);
  }

  complete(result: KernelBashCompletion) {
    return this.#port.complete(result);
  }
}

/** Forked ports must remain RPC capabilities when they cross the child worker boundary. */
export function createWorkerBashHost(options: KernelBashHostOptions) {
  const owner = createKernelBashHost(options);
  const credentials = {
    ...options.credentials,
    umask: options.context.filesystem.posixPolicy?.umask ?? options.credentials.umask,
  };
  return {
    host: new WorkerBashPort(owner.port, owner.pid, credentials),
    exited: owner.exited,
    close: owner.close,
  };
}
