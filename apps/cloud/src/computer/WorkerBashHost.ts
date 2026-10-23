import { RpcTarget } from "cloudflare:workers";
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
  KernelBashOperation,
  KernelBashOperationStart,
} from "../kernel/KernelBashPort.ts";
import type { KernelSyscallRequest } from "../kernel/KernelSyscallPort.ts";
import type { ChildHostLease, ChildHostRef } from "./ChildHostLease.ts";
import type { KernelBashForkSource } from "../kernel/KernelBashFork.ts";

class WorkerBashSnapshot extends RpcTarget implements KernelBashForkSource {
  readonly #source: ChildHostRef<KernelBashForkSource>;

  constructor(source: ChildHostRef<KernelBashForkSource>) {
    super();
    this.#source = source;
  }

  state() {
    return this.#source.get().state();
  }
  read(offset: number, length: number) {
    return this.#source.get().read(offset, length);
  }
  restored() {
    return this.#source.get().restored();
  }
}

export interface WorkerBashPhase {
  startOperation(
    port: KernelBashPort,
    operation: KernelBashOperation,
  ): Promise<KernelBashOperationStart>;
  park(
    port: KernelBashPort,
    pid: number,
    source: KernelBashForkSource,
    operationId?: string,
  ): Promise<void>;
  placeFork(port: KernelBashPort, pid: number, source: KernelBashForkSource): Promise<void>;
}

class WorkerBashPort extends RpcTarget implements KernelBashPort {
  readonly #lease: ChildHostLease;
  readonly #port: ChildHostRef<KernelBashPort>;
  readonly #pid: number;
  readonly #credentials: KernelBashCredentials;
  readonly #snapshot: ChildHostRef<KernelBashForkSource> | undefined;
  readonly #wrapFork: (port: KernelBashPort, pid: number) => WorkerBashPort;
  readonly #residentByteLimit: number | undefined;

  constructor(
    lease: ChildHostLease,
    port: KernelBashPort,
    pid: number,
    credentials: KernelBashCredentials,
    snapshot?: KernelBashForkSource,
    phase?: ChildHostRef<WorkerBashPhase>,
    residentByteLimit?: number,
  ) {
    super();
    this.#lease = lease;
    this.#port = lease.hold(port);
    this.#pid = pid;
    this.#credentials = credentials;
    this.#snapshot = snapshot === undefined ? undefined : lease.hold(snapshot);
    this.#residentByteLimit = residentByteLimit;
    this.#wrapFork = (forkPort, forkPid) =>
      workerBashPort(lease, forkPort, forkPid, credentials, undefined, phase, residentByteLimit);
  }

  metadata() {
    return {
      pid: this.#pid,
      credentials: { ...this.#credentials },
      ...(this.#residentByteLimit === undefined
        ? {}
        : { residentByteLimit: this.#residentByteLimit }),
    };
  }

  forkSnapshot() {
    return this.#snapshot === undefined ? undefined : new WorkerBashSnapshot(this.#snapshot);
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
          port: this.#wrapFork(result.port, result.pid),
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

class ParkableWorkerBashPort extends WorkerBashPort {
  readonly #phase: ChildHostRef<WorkerBashPhase>;
  readonly #process: ChildHostRef<KernelBashPort>;
  readonly #lease: ChildHostLease;
  readonly #pid: number;

  constructor(
    lease: ChildHostLease,
    port: KernelBashPort,
    pid: number,
    credentials: KernelBashCredentials,
    phase: ChildHostRef<WorkerBashPhase>,
    snapshot?: KernelBashForkSource,
    residentByteLimit?: number,
  ) {
    super(lease, port, pid, credentials, snapshot, phase, residentByteLimit);
    this.#phase = phase;
    this.#process = lease.hold(port);
    this.#lease = lease;
    this.#pid = pid;
  }

  async startOperation(operation: KernelBashOperation) {
    return this.#phase.get().startOperation(this.#process.get(), operation);
  }

  async park(source: KernelBashForkSource, operationId?: string) {
    return this.#phase.get().park(this.#process.get(), this.#pid, source, operationId);
  }

  async placeFork(source: KernelBashForkSource) {
    return this.#phase.get().placeFork(this.#process.get(), this.#pid, source);
  }

  observeResident(bytes: number) {
    this.#lease.observe(bytes);
  }
}

function workerBashPort(
  lease: ChildHostLease,
  port: KernelBashPort,
  pid: number,
  credentials: KernelBashCredentials,
  snapshot?: KernelBashForkSource,
  phase?: ChildHostRef<WorkerBashPhase>,
  residentByteLimit?: number,
): WorkerBashPort {
  return phase === undefined
    ? new WorkerBashPort(lease, port, pid, credentials, snapshot, undefined, residentByteLimit)
    : new ParkableWorkerBashPort(lease, port, pid, credentials, phase, snapshot, residentByteLimit);
}

export function createWorkerBashForkHost(
  options: KernelBashHostOptions,
  lease: ChildHostLease,
  owner: KernelBashForkHost,
  snapshot: KernelBashForkSource | undefined,
  phase?: WorkerBashPhase,
  residentByteLimit?: number,
) {
  return {
    host: workerBashPort(
      lease,
      owner.port,
      options.context.identity.pid,
      bashCredentials(options),
      snapshot,
      phase === undefined ? undefined : lease.hold(phase),
      residentByteLimit,
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
    host: workerBashPort(lease, owner.port, owner.pid, credentials),
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
