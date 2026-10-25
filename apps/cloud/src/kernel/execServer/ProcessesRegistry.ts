// @effect-diagnostics globalTimers:off - closed process replay expires after the Codex retention window.
import type { KernelCommandChild, KernelCommandForwarder } from "../KernelCommandForwarder.ts";
import { RpcError } from "../CodexExecProtocol.ts";
import type { Notification } from "../CodexExecProtocol.ts";
import { ProcessesInstance } from "./ProcessesInstance.ts";
import {
  prepareProcessLaunch,
  type PreparedProcessLaunch,
  type ProcessLaunchEnvironment,
} from "./ProcessesLaunch.ts";

export interface ProcessesRegistryOptions extends ProcessLaunchEnvironment {
  readonly spawn: KernelCommandForwarder["spawn"];
  readonly notify: (message: Notification) => Promise<void>;
  readonly sessionSignal: AbortSignal;
  readonly maxProcesses?: number;
  readonly maxWriteIdsPerProcess?: number;
  readonly maxWriteBytesPerProcess?: number;
  readonly maxDedupBytesPerProcess?: number;
  readonly closedRetentionMs?: number;
}

export type StartResponse = { readonly processId: string; readonly sandboxType: "none" };
export type StartingProcess = {
  readonly kind: "starting";
  readonly processId: string;
  readonly identity: string;
  readonly controller: AbortController;
  promise: Promise<StartResponse> | undefined;
  process: ProcessesInstance | undefined;
  unlink: () => void;
};
export type ProcessEntry = StartingProcess | ProcessesInstance;

const DEFAULT_MAX_PROCESSES = 64;
const DEFAULT_MAX_WRITE_IDS = 4096;
const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEDUP_BYTES = 1024 * 1024;
const DEFAULT_CLOSED_RETENTION_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

/** Process idempotency, admission and retained ownership for one exec-server session. */
export class ProcessesRegistry {
  readonly #options: ProcessesRegistryOptions;
  readonly #environment: ProcessLaunchEnvironment;
  readonly #processes = new Map<string, ProcessEntry>();
  readonly #detachedStarts = new Set<StartingProcess>();
  readonly #orphanChildren = new Set<KernelCommandChild>();
  readonly #orphanProcesses = new Set<ProcessesInstance>();
  readonly #retentionTimers = new Map<ProcessesInstance, ReturnType<typeof setTimeout>>();
  readonly #maxProcesses: number;
  readonly #maxWriteIds: number;
  readonly #maxWriteBytes: number;
  readonly #maxDedupBytes: number;
  readonly #closedRetentionMs: number;
  readonly #onSessionAbort: () => void;
  #closing = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: ProcessesRegistryOptions) {
    this.#options = options;
    this.#environment = {
      baseEnv: Object.freeze({ ...options.baseEnv }),
      ...(options.platformOs === undefined ? {} : { platformOs: options.platformOs }),
    };
    this.#maxProcesses = positiveLimit(
      options.maxProcesses,
      DEFAULT_MAX_PROCESSES,
      "maxProcesses",
      1024,
    );
    this.#maxWriteIds = positiveLimit(
      options.maxWriteIdsPerProcess,
      DEFAULT_MAX_WRITE_IDS,
      "maxWriteIdsPerProcess",
      50_000,
    );
    this.#maxWriteBytes = positiveLimit(
      options.maxWriteBytesPerProcess,
      DEFAULT_MAX_WRITE_BYTES,
      "maxWriteBytesPerProcess",
      16 * 1024 * 1024,
    );
    this.#maxDedupBytes = positiveLimit(
      options.maxDedupBytesPerProcess,
      DEFAULT_MAX_DEDUP_BYTES,
      "maxDedupBytesPerProcess",
      16 * 1024 * 1024,
    );
    this.#closedRetentionMs = positiveLimit(
      options.closedRetentionMs,
      DEFAULT_CLOSED_RETENTION_MS,
      "closedRetentionMs",
      MAX_TIMER_MS,
    );
    if (options.sessionSignal.aborted) throw new RpcError(-32600, "Exec-server session is closed");
    this.#onSessionAbort = () => this.#cancelPendingStarts();
    options.sessionSignal.addEventListener("abort", this.#onSessionAbort, { once: true });
  }

  get(processId: string) {
    return this.#processes.get(processId);
  }

  async start(value: unknown, requestSignal: AbortSignal): Promise<StartResponse> {
    if (this.#closing) throw new RpcError(-32600, "Exec-server session is closed");
    if (requestSignal.aborted || this.#options.sessionSignal.aborted) throw abortError();
    const prepared = prepareProcessLaunch(value, this.#environment);
    const current = this.#processes.get(prepared.processId);
    if (current) {
      if (current.identity !== prepared.identity) {
        throw new RpcError(
          -32600,
          `process ${prepared.processId} was already started with different parameters`,
        );
      }
      if (!isStarting(current)) return startResponse(prepared.processId);
      if (!current.promise) throw new RpcError(-32600, `process ${prepared.processId} is starting`);
      return waitForAbort(current.promise, [requestSignal, this.#options.sessionSignal]);
    }
    if (this.#ownedProcessCount() >= this.#maxProcesses) {
      throw new RpcError(-32603, "Too many processes in this exec-server session");
    }

    const entry: StartingProcess = {
      kind: "starting",
      processId: prepared.processId,
      identity: prepared.identity,
      controller: new AbortController(),
      promise: undefined,
      process: undefined,
      unlink: () => {},
    };
    const cancel = () => this.cancelStarting(entry);
    requestSignal.addEventListener("abort", cancel, { once: true });
    this.#options.sessionSignal.addEventListener("abort", cancel, { once: true });
    entry.unlink = () => {
      requestSignal.removeEventListener("abort", cancel);
      this.#options.sessionSignal.removeEventListener("abort", cancel);
    };
    this.#processes.set(entry.processId, entry);
    const starting = this.#runStart(entry, prepared);
    entry.promise = starting;
    void starting.catch(() => {});
    if (requestSignal.aborted || this.#options.sessionSignal.aborted) cancel();
    return waitForAbort(starting, [requestSignal, this.#options.sessionSignal]);
  }

  cancelStarting(entry: StartingProcess) {
    const current = this.#processes.get(entry.processId);
    if (current === entry || current === entry.process) this.#processes.delete(entry.processId);
    this.#detachedStarts.add(entry);
    if (!entry.controller.signal.aborted) entry.controller.abort();
  }

  async dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const cleanup = this.#disposeAll();
    this.#disposePromise = cleanup;
    try {
      await cleanup;
    } finally {
      this.#disposePromise = undefined;
    }
  }

  async #runStart(entry: StartingProcess, prepared: PreparedProcessLaunch): Promise<StartResponse> {
    try {
      if (entry.controller.signal.aborted) throw abortError();
      const child = await this.#options.spawn(prepared.command, entry.controller.signal);
      if (
        entry.controller.signal.aborted ||
        this.#processes.get(entry.processId) !== entry ||
        this.#closing
      ) {
        await this.#disposeLateChild(child);
        throw abortError();
      }

      let process: ProcessesInstance;
      try {
        process = new ProcessesInstance({
          processId: entry.processId,
          identity: entry.identity,
          child,
          pipeStdin: prepared.pipeStdin,
          notify: this.#options.notify,
          maxWriteIds: this.#maxWriteIds,
          maxWriteBytes: this.#maxWriteBytes,
          maxDedupBytes: this.#maxDedupBytes,
          onClosed: (closed) => this.#scheduleExpiry(closed),
          onCleanupFailure: (failed) => this.#orphanProcesses.add(failed),
        });
      } catch {
        await this.#disposeLateChild(child);
        throw new RpcError(-32603, "Failed to initialize process streams");
      }
      entry.process = process;
      if (
        entry.controller.signal.aborted ||
        this.#processes.get(entry.processId) !== entry ||
        this.#closing
      ) {
        await this.#disposeLateProcess(process);
        throw abortError();
      }

      this.#processes.set(entry.processId, process);
      process.start();
      return startResponse(entry.processId);
    } catch (error) {
      if (
        this.#processes.get(entry.processId) === entry ||
        this.#processes.get(entry.processId) === entry.process
      ) {
        this.#processes.delete(entry.processId);
      }
      if (entry.process) await this.#disposeLateProcess(entry.process);
      this.#detachedStarts.delete(entry);
      if (entry.controller.signal.aborted || isAbortError(error)) throw abortError();
      if (error instanceof RpcError) throw error;
      throw new RpcError(-32603, `Failed to start process: ${errorMessage(error)}`);
    } finally {
      entry.unlink();
      this.#detachedStarts.delete(entry);
    }
  }

  #cancelPendingStarts() {
    for (const entry of this.#processes.values()) if (isStarting(entry)) this.cancelStarting(entry);
  }

  #scheduleExpiry(process: ProcessesInstance) {
    if (this.#closing || this.#processes.get(process.processId) !== process) return;
    const timer = setTimeout(() => {
      this.#retentionTimers.delete(process);
      if (
        this.#processes.get(process.processId) === process &&
        process.closed &&
        process.childDisposed
      ) {
        this.#processes.delete(process.processId);
        process.log.dispose();
        this.#orphanProcesses.delete(process);
      }
    }, this.#closedRetentionMs);
    this.#retentionTimers.set(process, timer);
  }

  #ownedProcessCount() {
    return new Set<unknown>([
      ...this.#processes.values(),
      ...this.#detachedStarts,
      ...this.#orphanChildren,
      ...this.#orphanProcesses,
    ]).size;
  }

  async #disposeLateChild(child: KernelCommandChild) {
    try {
      await child.dispose();
    } catch {
      this.#orphanChildren.add(child);
    }
  }

  async #disposeLateProcess(process: ProcessesInstance) {
    try {
      await process.dispose();
    } catch {
      this.#orphanProcesses.add(process);
    }
  }

  async #disposeAll() {
    this.#closing = true;
    this.#options.sessionSignal.removeEventListener("abort", this.#onSessionAbort);
    const starts = new Set<StartingProcess>([
      ...[...this.#processes.values()].filter(isStarting),
      ...this.#detachedStarts,
    ]);
    for (const start of starts) this.cancelStarting(start);
    await Promise.allSettled(
      [...starts].flatMap((start) => (start.promise ? [start.promise] : [])),
    );

    for (const timer of this.#retentionTimers.values()) clearTimeout(timer);
    this.#retentionTimers.clear();

    const processes = new Set<ProcessesInstance>([
      ...[...this.#processes.values()].filter(isRunning),
      ...this.#orphanProcesses,
    ]);
    const children = new Set(this.#orphanChildren);
    const results = await Promise.allSettled([
      ...[...processes].map((process) => process.dispose()),
      ...[...children].map((child) => child.dispose()),
    ]);
    const processList = [...processes];
    const childList = [...children];
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      if (index < processList.length) {
        const process = processList[index]!;
        if (this.#processes.get(process.processId) === process)
          this.#processes.delete(process.processId);
        this.#orphanProcesses.delete(process);
      } else {
        this.#orphanChildren.delete(childList[index - processList.length]!);
      }
    });
    if (errors.length > 0) throw new AggregateError(errors, "Exec-server process cleanup failed");
    this.#processes.clear();
    this.#detachedStarts.clear();
    this.#orphanChildren.clear();
    this.#orphanProcesses.clear();
  }
}

export function isStarting(entry: ProcessEntry): entry is StartingProcess {
  return "kind" in entry && entry.kind === "starting";
}

function isRunning(entry: ProcessEntry): entry is ProcessesInstance {
  return !isStarting(entry);
}

function startResponse(processId: string): StartResponse {
  return { processId, sandboxType: "none" };
}

function positiveLimit(value: number | undefined, fallback: number, name: string, maximum: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${name} must be a positive safe integer at most ${maximum}`);
  }
  return result;
}

function waitForAbort<T>(promise: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  if (signals.some((signal) => signal.aborted)) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signals.forEach((signal) => signal.removeEventListener("abort", onAbort));
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signals.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    if (signals.some((signal) => signal.aborted)) onAbort();
  });
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}
