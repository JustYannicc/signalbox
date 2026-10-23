import { RpcTarget } from "cloudflare:workers";
import { WorkerBashSnapshot } from "./WorkerBashSnapshot.ts";
import {
  createKernelBashHost,
  type KernelBashHostOptions,
  type KernelBashForkHost,
} from "../kernel/KernelBashHost.ts";
import type { KernelBashCredentials } from "../kernel/KernelBashProgram.ts";
import type {
  KernelBashCall,
  KernelBashCompletion,
  KernelBashPort,
} from "../kernel/KernelBashPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";

class WorkerBashPort extends RpcTarget implements KernelBashPort {
  readonly #lease: ChildHostLease;
  readonly #port: ChildHostRef<KernelBashPort>;
  readonly #pid: number;
  readonly #credentials: KernelBashCredentials;
  readonly #snapshot: WorkerBashSnapshot | undefined;

  constructor(
    lease: ChildHostLease,
    port: KernelBashPort,
    pid: number,
    credentials: KernelBashCredentials,
    snapshot?: KernelBashForkSource,
  ) {
    super();
    this.#lease = lease;
    this.#port = lease.hold(port);
    this.#pid = pid;
    this.#credentials = credentials;
    this.#snapshot = snapshot === undefined ? undefined : new WorkerBashSnapshot(lease, snapshot);
  }

  metadata() {
    return { pid: this.#pid, credentials: { ...this.#credentials } };
  }

  forkSnapshot() {
    return this.#snapshot;
  }

  async runFork(source: KernelBashForkSource) {
    return this.#port.get().runFork(source);
  }

  async call(request: KernelSyscallRequest) {
    this.#lease.observe(request.residentWasmBytes ?? request.memorySize);
    return this.#port.get().call(request);
  }

  async callBash(request: KernelBashCall) {
    this.#lease.observe(request.residentWasmBytes ?? request.memorySize);
    return this.#port.get().callBash(request);
  }

  observeResident(bytes: number) {
    this.#lease.observe(bytes);
  }

  async fork() {
    const result = await this.#port.get().fork();
    return result.kind === "fork"
      ? {
          ...result,
          port: new WorkerBashPort(this.#lease, result.port, result.pid, this.#credentials),
        }
      : result;
  }

  async wait(pid: number, options: number) {
    return this.#port.get().wait(pid, options);
  }

  async exec(request: Parameters<KernelBashPort["exec"]>[0]) {
    return this.#port.get().exec(request);
  }

  async complete(result: KernelBashCompletion) {
    const completed = await this.#port.get().complete(result);
    // A completed process rejects every later call, so its fork state can go before the command.
    this.#lease.drop(this.#port);
    return completed;
  }
}

export function createWorkerBashForkHost(
  options: KernelBashHostOptions,
  lease: ChildHostLease,
  owner: KernelBashForkHost,
  snapshot: KernelBashForkSource,
) {
  return {
    host: new WorkerBashPort(
      lease,
      owner.port,
      options.context.identity.pid,
      bashCredentials(options),
      snapshot,
    ),
    // Placement must wait for restoration before a logical exit can reach the parent.
    close: owner.close,
  };
}

/** Forked ports must remain RPC capabilities when they cross the child worker boundary. */
export function createWorkerBashHost(options: KernelBashHostOptions, lease: ChildHostLease) {
  const owner = createKernelBashHost(options);
  const credentials = bashCredentials(options);
  return {
    host: new WorkerBashPort(lease, owner.port, owner.pid, credentials),
    exited: owner.exited,
    close: owner.close,
  };
}

function bashCredentials(options: KernelBashHostOptions) {
  return {
    ...options.credentials,
    umask: options.context.filesystem.posixPolicy?.umask ?? options.credentials.umask,
  };
}
