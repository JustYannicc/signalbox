// @effect-diagnostics nodeBuiltinImport:off - the worker runtime supports AsyncLocalStorage.
import * as NodeAsyncHooks from "node:async_hooks";

import {
  KernelCpuAccounting,
  type KernelCpuProcess,
  type KernelCpuSnapshot,
} from "./KernelCpuAccounting.ts";

type CpuMode = "user" | "system";

interface ScopeFrame {
  readonly mode: CpuMode;
  activeLeave: (() => void) | undefined;
  closed: boolean;
}

interface ExecutionState {
  readonly process: KernelCpuProcessExecution;
  readonly frames: ScopeFrame[];
}

const executionContexts = new NodeAsyncHooks.AsyncLocalStorage<ExecutionState>();
const noOp = () => {};

/** A logical process context; `run` propagates identity but does not charge async waits. */
export class KernelCpuProcessExecution {
  readonly pid: number;
  readonly #execution: KernelCpuExecution;
  readonly #accounting: KernelCpuProcess;
  #stopped = false;
  #finalSnapshot: KernelCpuSnapshot | undefined;

  constructor(execution: KernelCpuExecution, pid: number, accounting: KernelCpuProcess) {
    this.#execution = execution;
    this.pid = pid;
    this.#accounting = accounting;
  }

  /** Selects this PID for sync and detached async work without holding a CPU scope. */
  run<T>(run: () => T): T {
    this.#assertUsable();
    return this.#execution.run(this, run);
  }

  /** Charges only this synchronous user slice and rejects Promise-like results. */
  runUser<T>(run: () => T): T {
    return this.#runMode("user", run);
  }

  /** Charges only this synchronous kernel slice and rejects Promise-like results. */
  runSystem<T>(run: () => T): T {
    return this.#runMode("system", run);
  }

  /** Opens a user slice in this process's active `run` context. */
  enterUser(): () => void {
    return this.#enter("user");
  }

  /** Opens a synchronous kernel slice in this process's active `run` context. */
  enterSystem(): () => void {
    return this.#enter("system");
  }

  snapshot(): KernelCpuSnapshot {
    if (this.#stopped) return this.#finalSnapshot!;
    return this.#accounting.snapshot();
  }

  /** Disposes the inactive process record and returns its final counters. */
  stop(): KernelCpuSnapshot {
    this.#assertUsable();
    const snapshot = this.snapshot();
    this.#accounting.dispose();
    this.#stopped = true;
    this.#finalSnapshot = snapshot;
    this.#execution.forget(this);
    return snapshot;
  }

  _assertUsable(): void {
    this.#assertUsable();
  }

  _enter(mode: CpuMode): () => void {
    this.#assertUsable();
    return mode === "user" ? this.#accounting.enterUser() : this.#accounting.enterSystem();
  }

  #runMode<T>(mode: CpuMode, run: () => T): T {
    this.#assertUsable();
    return this.#execution.run(this, () => {
      const state = executionContexts.getStore();
      if (!state || state.process !== this) throw new Error("CPU process context was lost");
      const leave = enterScope(state, mode);
      let result: T;
      try {
        result = run();
      } catch (error) {
        leave();
        throw error;
      }
      leave();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("CPU accounting helpers cannot wrap asynchronous work");
      }
      return result;
    });
  }

  #enter(mode: CpuMode): () => void {
    this.#assertUsable();
    const state = executionContexts.getStore();
    if (!state || state.process !== this) {
      throw new Error("Call enterUser or enterSystem inside this process's run context");
    }
    return enterScope(state, mode);
  }

  #assertUsable(): void {
    if (this.#stopped) throw new Error("CPU process execution is stopped");
  }
}

/** Owns per-PID accounting handles and the shared async process selector. */
export class KernelCpuExecution {
  readonly #accounting: KernelCpuAccounting;
  readonly #processes = new Map<number, KernelCpuProcessExecution>();
  readonly root: KernelCpuProcessExecution;

  constructor(accounting: KernelCpuAccounting) {
    this.#accounting = accounting;
    this.root = this.forProcess(1);
  }

  forProcess(pid: number): KernelCpuProcessExecution {
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new RangeError("processId must be a positive safe integer");
    }
    const existing = this.#processes.get(pid);
    if (existing) return existing;
    const process = new KernelCpuProcessExecution(this, pid, this.#accounting.forProcess(pid));
    this.#processes.set(pid, process);
    return process;
  }

  current(): KernelCpuProcessExecution | undefined {
    return executionContexts.getStore()?.process;
  }

  run<T>(process: KernelCpuProcessExecution, run: () => T): T {
    process._assertUsable();
    const current = executionContexts.getStore();
    if (current?.process === process) return run();
    return executionContexts.run({ process, frames: [] }, run);
  }

  forget(process: KernelCpuProcessExecution): void {
    if (this.#processes.get(process.pid) === process) this.#processes.delete(process.pid);
  }
}

export interface KernelCpuExecutionCapture {
  run<T>(run: () => T): T;
  pause(): () => void;
}

/** Returns the current process's sync syscall wrapper, or runs directly outside a process. */
export function runCurrentKernelCpuSystem<T>(run: () => T): T {
  const state = executionContexts.getStore();
  return state ? state.process.runSystem(run) : run();
}

/** Begins user accounting around a WASM export; imported waits pause and resume this scope. */
export function enterCurrentKernelCpuUser(): () => void {
  const state = executionContexts.getStore();
  return state ? enterScope(state, "user") : noOp;
}

/** Runs a synchronous imported syscall while pausing the active user slice. */
export function runCurrentKernelCpuSystemImport<T>(run: () => T): T {
  const state = executionContexts.getStore();
  if (!state) return run();
  const resume = pauseState(state);
  try {
    return state.process.runSystem(run);
  } finally {
    resume();
  }
}

/** Runs generator steps as system work while leaving each yielded Promise uncharged. */
export async function runCurrentKernelCpuAsyncSystemImport<T>(
  run: (runSystem: <V>(step: () => V) => V) => T | PromiseLike<T>,
): Promise<T> {
  const state = executionContexts.getStore();
  if (!state) return await run((step) => step());
  const resume = pauseState(state);
  try {
    const leaveSystem = enterScope(state, "system");
    let result: T | PromiseLike<T>;
    try {
      result = run((step) => runCurrentKernelCpuSystem(step));
    } finally {
      leaveSystem();
    }
    const value = await result;
    return state.process.runSystem(() => value);
  } finally {
    resume();
  }
}

/** Wraps async host imports whose only blocking path is a KernelWakeRegistry wait. */
export async function runCurrentKernelCpuAwaitableSystemImport<T>(
  run: () => T | PromiseLike<T>,
): Promise<T> {
  const state = executionContexts.getStore();
  if (!state) return await run();
  const resumeUser = pauseState(state);
  const leaveSystem = enterScope(state, "system");
  try {
    return await run();
  } finally {
    leaveSystem();
    resumeUser();
  }
}

/** Captures identity and a pause hook so a wake callback cannot inherit its signaler's PID. */
export function captureKernelCpuExecution(): KernelCpuExecutionCapture | undefined {
  const state = executionContexts.getStore();
  if (!state) return undefined;
  return {
    run: (run) => executionContexts.run(state, run),
    pause: () => pauseState(state),
  };
}

function enterScope(state: ExecutionState, mode: CpuMode): () => void {
  const previous = state.frames.at(-1);
  const resumePrevious = previous?.activeLeave !== undefined;
  if (previous?.activeLeave) {
    previous.activeLeave();
    previous.activeLeave = undefined;
  }

  const frame: ScopeFrame = { mode, activeLeave: undefined, closed: false };
  state.frames.push(frame);
  frame.activeLeave = state.process._enter(mode);
  let left = false;
  return () => {
    if (left) throw new Error("CPU execution scope has already been left");
    if (state.frames.at(-1) !== frame) {
      throw new Error("CPU execution scopes must be left in reverse entry order");
    }
    frame.activeLeave?.();
    frame.activeLeave = undefined;
    frame.closed = true;
    state.frames.pop();
    const resumed = state.frames.at(-1);
    if (resumed && resumePrevious) resumed.activeLeave = state.process._enter(resumed.mode);
    left = true;
  };
}

function pauseState(state: ExecutionState): () => void {
  const frame = state.frames.at(-1);
  if (!frame?.activeLeave) return noOp;
  frame.activeLeave();
  frame.activeLeave = undefined;
  let resumed = false;
  return () => {
    if (resumed || frame.closed) return;
    if (state.frames.at(-1) !== frame || frame.activeLeave !== undefined) return;
    frame.activeLeave = state.process._enter(frame.mode);
    resumed = true;
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}
