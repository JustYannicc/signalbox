import {
  KernelResourceTable,
  attemptKernelOperation,
  kernelError,
  kernelOk,
  type KernelHandle,
  type KernelHandleKind,
  type KernelResult,
} from "./KernelAbi.ts";
import type { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { KernelProcessCleanup } from "./process/KernelProcessCleanup.ts";
import { isKernelProcessCancelledError } from "./process/KernelProcessCancellation.ts";
import {
  KERNEL_WNOHANG,
  KernelProcessWaiters,
  type KernelExitStatus,
  type KernelWaitOutcome,
  type KernelWaitPidResult,
} from "./process/KernelProcessWaiters.ts";

export { KERNEL_WNOHANG } from "./process/KernelProcessWaiters.ts";
export type { KernelExitStatus, KernelWaitPidResult } from "./process/KernelProcessWaiters.ts";

export interface KernelLaunchedChild {
  readonly completion: Promise<KernelExitStatus>;
  readonly signal: (signal: number) => KernelResult<void>;
}

export interface KernelProcessInfo {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
}

export interface KernelProcessLookup {
  readonly handle: KernelHandle<"process">;
  readonly info: KernelProcessInfo;
  readonly status: "running" | "exited" | "cancelled" | "failed";
}

export interface KernelProcessIdentity {
  readonly handle: KernelHandle<"process">;
  readonly pid: number;
}

const ROOT_PID = 1;
const FIRST_CHILD_PID = 2;
const MAX_PID = 0x7fffffff;
const SIGKILL = 9;

type ProcessOutcome = KernelWaitOutcome;
type CompletionResult = ProcessOutcome;
type ProcessRecord = {
  readonly pid: number;
  parentPid: number;
  readonly processGroupId: number;
  readonly handle: KernelHandle<"process">;
  child: KernelLaunchedChild | undefined;
  settled: Promise<void> | undefined;
  readonly cleanup: () => Promise<void>;
  readonly listeners: Set<() => void>;
  completionObserved: boolean;
  outcome: ProcessOutcome | undefined;
};
type ProcessResources = Record<KernelHandleKind, unknown> & { process: ProcessRecord };

/** Request-owned process identity and completion state. PIDs 0 and 1 stay reserved. */
export class KernelProcessTable {
  readonly #wakes: KernelWakeRegistry;
  readonly #maxProcesses: number;
  readonly #resources: KernelResourceTable<ProcessResources>;
  readonly #cleanup = new KernelProcessCleanup();
  readonly #waiters: KernelProcessWaiters;
  readonly #processes = new Map<number, ProcessRecord>();
  readonly #reservedPids = new Set<number>();
  #nextPid = FIRST_CHILD_PID;
  #admissions = 0;
  #closed = false;
  #disposePromise: Promise<KernelResult<void>> | undefined;
  #disposeRunning = false;

  constructor(options: { readonly wakes: KernelWakeRegistry; readonly maxProcesses?: number }) {
    this.#wakes = options.wakes;
    this.#maxProcesses = options.maxProcesses ?? 256;
    if (!Number.isSafeInteger(this.#maxProcesses) || this.#maxProcesses < 1) {
      throw new RangeError("maxProcesses must be a positive safe integer");
    }
    this.#resources = new KernelResourceTable<ProcessResources>(this.#maxProcesses);
    this.#waiters = new KernelProcessWaiters(this.#wakes);
  }

  get size() {
    return this.#processes.size;
  }

  /** The root guest is PID 1; a child launch is never started before admission succeeds. */
  spawn(
    parentHandle: KernelHandle<"process"> | undefined,
    launch: (identity: KernelProcessIdentity) => KernelLaunchedChild,
    release: () => void | Promise<void>,
    options: { readonly processGroupId?: number } = {},
  ): KernelResult<{ readonly handle: KernelHandle<"process">; readonly pid: number }> {
    const cleanupOnce = this.#cleanup.own(release);
    const reject = <T>(result: KernelResult<T>): KernelResult<T> => {
      void cleanupOnce();
      return result;
    };

    if (this.#closed) return reject(kernelError("CANCELLED", "Process table is closed"));
    const parentInfo = this.info(parentHandle);
    if (parentInfo.status !== "ok") return reject(parentInfo);
    if (parentHandle !== undefined) {
      const parent = this.#record(parentHandle);
      if (parent.status !== "ok") return reject(parent);
      if (parent.value.completionObserved || parent.value.outcome) {
        return reject(kernelError("NOT_FOUND", "Parent process has already exited"));
      }
    }
    if (this.#processes.size + this.#admissions >= this.#maxProcesses) {
      return reject(kernelError("RESOURCE_LIMIT", "Too many child processes"));
    }

    const pid = this.#allocatePid();
    if (pid === undefined)
      return reject(kernelError("RESOURCE_LIMIT", "Process id space exhausted"));
    const processGroupId = this.#resolveGroup(
      options.processGroupId,
      parentInfo.value.processGroupId,
      pid,
    );
    if (processGroupId.status !== "ok") return reject(processGroupId);

    this.#admissions++;
    this.#reservedPids.add(pid);
    let record: ProcessRecord | undefined;
    let admissionReserved = true;
    try {
      const slot = {} as ProcessRecord;
      const allocated = this.#resources.allocate("process", slot);
      if (allocated.status !== "ok") {
        return reject(allocated);
      }
      record = slot;
      Object.assign(record, {
        pid,
        parentPid: parentInfo.value.pid,
        processGroupId: processGroupId.value,
        handle: allocated.value,
        child: undefined,
        settled: undefined,
        cleanup: cleanupOnce,
        listeners: new Set(),
        completionObserved: false,
        outcome: undefined,
      } satisfies Omit<ProcessRecord, "handle"> & { handle: KernelHandle<"process"> });
      this.#processes.set(pid, record);
      this.#admissions--;
      this.#reservedPids.delete(pid);
      admissionReserved = false;

      const identity = { handle: record.handle, pid };
      const child = launch(identity);
      record.child = child;
      record.settled = Promise.resolve(child.completion)
        .then(
          (status) => this.#complete(record!, { kind: "exited", status }),
          (error: unknown) => this.#complete(record!, { kind: "failed", error }),
        )
        .catch((error: unknown) => this.#complete(record!, { kind: "failed", error }));
      if (this.#closed) return kernelError("CANCELLED", "Process table closed during launch");
      return kernelOk({ handle: record.handle, pid });
    } catch {
      if (record) this.#reap(record);
      return reject(kernelError("IO_ERROR", "Process launch failed"));
    } finally {
      if (admissionReserved) {
        this.#admissions--;
        this.#reservedPids.delete(pid);
      }
    }
  }

  info(handle?: KernelHandle<"process">): KernelResult<KernelProcessInfo> {
    if (handle === undefined)
      return kernelOk({ pid: ROOT_PID, parentPid: 0, processGroupId: ROOT_PID });
    const record = this.#record(handle);
    return record.status === "ok"
      ? kernelOk({
          pid: record.value.pid,
          parentPid: record.value.parentPid,
          processGroupId: record.value.processGroupId,
        })
      : record;
  }

  /** Process.wait is a repeatable observation and does not reap the child. */
  wait(handle: KernelHandle<"process">): KernelResult<{ readonly exitCode: number }> {
    const result = this.exitStatus(handle);
    if (result.status === "error") return result;
    if (result.status === "would_block") {
      return { status: "would_block", wakeToken: result.wakeToken };
    }
    return kernelOk({ exitCode: result.value.exitCode });
  }

  /** Full terminal status is a repeatable observation until the handle is reaped. */
  exitStatus(handle: KernelHandle<"process">): KernelResult<KernelExitStatus> {
    const record = this.#record(handle);
    if (record.status !== "ok") return record;
    return attemptKernelOperation(
      this.#wakes,
      (wake) => this.#subscribe(record.value.listeners, wake),
      () => {
        if (this.#closed) return kernelError("CANCELLED", "Process table is closed");
        const outcome = record.value.outcome;
        if (!outcome) return { status: "would_block" };
        return outcome.kind === "exited"
          ? kernelOk(outcome.status)
          : outcome.kind === "cancelled"
            ? kernelError("CANCELLED", outcome.error.message)
            : kernelError("IO_ERROR", "Child process completion failed");
      },
    );
  }

  /** Removes one terminal child. A live process cannot be reaped by handle. */
  reap(handle: KernelHandle<"process">): KernelResult<void> {
    const record = this.#record(handle);
    if (record.status !== "ok") return record;
    if (this.#closed) return kernelError("CANCELLED", "Process table is closed");
    const outcome = record.value.outcome;
    if (!outcome) return kernelError("ALREADY_WAITING", "Cannot reap a running process");
    this.#reap(record.value);
    return outcome.kind === "exited"
      ? kernelOk(undefined)
      : outcome.kind === "cancelled"
        ? kernelError("CANCELLED", outcome.error.message)
        : kernelError("IO_ERROR", "Child process completion failed");
  }

  /** Resolves a live or unreaped PID to its existing opaque process handle. */
  lookupPid(pid: number): KernelResult<KernelProcessLookup> {
    if (!Number.isSafeInteger(pid) || pid < ROOT_PID || pid > MAX_PID) {
      return kernelError("INVALID_ARGUMENT", "Invalid process id");
    }
    const process = this.#processes.get(pid);
    if (!process) return kernelError("NOT_FOUND", "Process id does not exist");
    const status =
      process.outcome === undefined
        ? "running"
        : process.outcome.kind === "exited"
          ? "exited"
          : process.outcome.kind === "cancelled"
            ? "cancelled"
            : "failed";
    return kernelOk({
      handle: process.handle,
      info: {
        pid: process.pid,
        parentPid: process.parentPid,
        processGroupId: process.processGroupId,
      },
      status,
    });
  }

  /** POSIX-style waitpid; a successful terminal status is consumed exactly once. */
  waitpid(
    parentHandle: KernelHandle<"process"> | undefined,
    selector: number,
    options = 0,
  ): KernelResult<KernelWaitPidResult> {
    if (!Number.isSafeInteger(selector) || selector < -MAX_PID || selector > MAX_PID) {
      return kernelError("INVALID_ARGUMENT", "Invalid waitpid selector");
    }
    if (!Number.isSafeInteger(options) || options < 0 || (options & ~KERNEL_WNOHANG) !== 0) {
      return kernelError("INVALID_ARGUMENT", "Invalid waitpid options");
    }
    const parent = this.info(parentHandle);
    if (parent.status !== "ok") return parent;

    return this.#waiters.waitpid(
      parent.value.pid,
      parent.value.processGroupId,
      selector,
      options,
      this.#processes.values(),
      () => this.#closed,
      (process) => this.#reap(process),
    );
  }

  signal(handle: KernelHandle<"process">, signal: number): KernelResult<void> {
    if (!Number.isSafeInteger(signal) || signal < 1 || signal > 64) {
      return kernelError("INVALID_ARGUMENT", "Invalid process signal");
    }
    const record = this.#record(handle);
    if (record.status !== "ok") return record;
    if (record.value.completionObserved || record.value.outcome) {
      return kernelError("NOT_FOUND", "Process has already exited");
    }
    if (!record.value.child)
      return kernelError("ALREADY_WAITING", "Process launch is still in progress");
    try {
      return record.value.child.signal(signal);
    } catch {
      return kernelError("IO_ERROR", "Process signal failed");
    }
  }

  /** Signals matching live direct children, using waitpid selector semantics. */
  signalPid(
    parentHandle: KernelHandle<"process"> | undefined,
    selector: number,
    signal: number,
  ): KernelResult<void> {
    if (!Number.isSafeInteger(selector) || selector < -MAX_PID || selector > MAX_PID) {
      return kernelError("INVALID_ARGUMENT", "Invalid process selector");
    }
    if (!Number.isSafeInteger(signal) || signal < 0 || signal > 64) {
      return kernelError("INVALID_ARGUMENT", "Invalid process signal");
    }
    const parent = this.info(parentHandle);
    if (parent.status !== "ok") return parent;
    if (this.#closed) return kernelError("CANCELLED", "Process table is closed");

    const targets = [...this.#processes.values()]
      .filter((process) => process.parentPid === parent.value.pid)
      .filter((process) =>
        this.#waiters.matchesSelector(process, parent.value.processGroupId, selector),
      )
      .filter((process) => !process.completionObserved && process.outcome === undefined);
    if (targets.length === 0) return kernelError("NOT_FOUND", "No matching live child process");
    if (signal === 0) return kernelOk(undefined);

    let accepted = false;
    let firstFailure: KernelResult<void> | undefined;
    const blocked: Extract<KernelResult<void>, { readonly status: "would_block" }>[] = [];
    for (const process of targets) {
      const result = this.signal(process.handle, signal);
      if (result.status === "ok") accepted = true;
      else if (result.status === "would_block") blocked.push(result);
      else if (!firstFailure) firstFailure = result;
    }
    if (accepted) {
      for (const result of blocked) this.#wakes.release(result.wakeToken);
      return kernelOk(undefined);
    }
    if (blocked.length > 0) {
      const [first, ...rest] = blocked;
      for (const result of rest) this.#wakes.release(result.wakeToken);
      return first!;
    }
    return firstFailure ?? kernelError("NOT_FOUND", "No matching live child process");
  }

  dispose(): Promise<KernelResult<void>> {
    if (this.#disposeRunning && this.#disposePromise) return this.#disposePromise;
    if (!this.#closed) {
      this.#closed = true;
      this.#waiters.notify();
      for (const record of this.#processes.values()) this.#notify(record.listeners);
    }
    this.#disposeRunning = true;
    let attempt!: Promise<KernelResult<void>>;
    attempt = Promise.resolve()
      .then(() => this.#drain())
      .finally(() => {
        if (this.#disposePromise === attempt) this.#disposeRunning = false;
      });
    this.#disposePromise = attempt;
    return attempt;
  }

  #record(handle: KernelHandle<"process">) {
    return this.#resources.get(handle, "process");
  }

  #subscribe(listeners: Set<() => void>, wake: () => void) {
    listeners.add(wake);
    return () => listeners.delete(wake);
  }

  #notify(listeners: Set<() => void>) {
    for (const wake of Array.from(listeners)) wake();
  }

  #resolveGroup(
    requested: number | undefined,
    inherited: number,
    pid: number,
  ): KernelResult<number> {
    if (requested === undefined) return kernelOk(inherited);
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > MAX_PID) {
      return kernelError("INVALID_ARGUMENT", "Invalid process group id");
    }
    if (requested === 0) return kernelOk(pid);
    const exists =
      requested === ROOT_PID ||
      [...this.#processes.values()].some(
        (process) =>
          process.processGroupId === requested &&
          !process.completionObserved &&
          process.outcome === undefined,
      );
    return exists
      ? kernelOk(requested)
      : kernelError("PERMISSION_DENIED", "Process group does not exist");
  }

  #allocatePid() {
    let candidate = this.#nextPid;
    for (let attempts = 0; attempts <= this.#processes.size + this.#reservedPids.size; attempts++) {
      if (candidate > MAX_PID) candidate = FIRST_CHILD_PID;
      const next = candidate === MAX_PID ? FIRST_CHILD_PID : candidate + 1;
      this.#nextPid = next;
      if (!this.#processes.has(candidate) && !this.#reservedPids.has(candidate)) return candidate;
      candidate = next;
    }
    return undefined;
  }

  async #complete(record: ProcessRecord, result: CompletionResult) {
    record.completionObserved = true;
    let outcome: ProcessOutcome;
    try {
      await record.cleanup();
      if (result.kind === "cancelled") {
        outcome = result;
      } else if (result.kind === "failed") {
        outcome = isKernelProcessCancelledError(result.error)
          ? { kind: "cancelled", error: result.error }
          : result;
      } else {
        const status = this.#validateStatus(result.status);
        outcome = status
          ? { kind: "exited", status }
          : { kind: "failed", error: new Error("Invalid process exit status") };
      }
    } catch (error) {
      outcome = { kind: "failed", error };
    }
    if (this.#processes.get(record.pid) !== record) return;
    if (this.#closed) {
      this.#reap(record);
      return;
    }
    record.outcome = outcome;
    this.#notify(record.listeners);
    this.#waiters.notify();
  }

  #validateStatus(status: KernelExitStatus): KernelExitStatus | undefined {
    try {
      if (!status || typeof status !== "object") return undefined;
      const exitCode = status.exitCode;
      const signal = status.signal;
      const coreDumped = status.coreDumped;
      if (
        !Number.isSafeInteger(exitCode) ||
        exitCode < 0 ||
        exitCode > 0xffff_ffff ||
        !Number.isSafeInteger(signal) ||
        signal < 0 ||
        signal > 64 ||
        typeof coreDumped !== "boolean"
      )
        return undefined;
      return Object.freeze({ exitCode, signal, coreDumped });
    } catch {
      return undefined;
    }
  }

  #reap(record: ProcessRecord) {
    this.#processes.delete(record.pid);
    this.#resources.take(record.handle, "process");
    this.#notify(record.listeners);
    this.#waiters.notify();
    for (const child of this.#processes.values()) {
      if (child.parentPid === record.pid) child.parentPid = ROOT_PID;
    }
  }

  async #drain(): Promise<KernelResult<void>> {
    const records = [...this.#processes.values()];
    let signalFailures = 0;
    const settled: Promise<void>[] = [];
    for (const record of records) {
      if (!record.child || !record.settled) {
        signalFailures++;
        continue;
      }
      if (record.outcome || record.completionObserved) {
        settled.push(record.settled);
        continue;
      }
      try {
        const result = record.child.signal(SIGKILL);
        if (result.status === "ok") settled.push(record.settled);
        else signalFailures++;
      } catch {
        signalFailures++;
      }
    }
    if (signalFailures > 0) {
      await Promise.all(
        records.flatMap((record) =>
          record.completionObserved && record.settled ? [record.settled] : [],
        ),
      );
      for (const record of records) {
        if (record.outcome) this.#reap(record);
      }
      await this.#cleanup.drain();
      return kernelError("IO_ERROR", "One or more child processes rejected termination");
    }
    await Promise.all(settled);
    const cleanupsSucceeded = await this.#cleanup.drain();
    for (const record of records) this.#reap(record);
    if (!cleanupsSucceeded) {
      return kernelError("IO_ERROR", "One or more child process cleanups failed");
    }
    return kernelOk(undefined);
  }
}
