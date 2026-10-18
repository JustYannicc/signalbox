// @effect-diagnostics nodeBuiltinImport:off - the worker runtime supports AsyncLocalStorage.
import * as NodeAsyncHooks from "node:async_hooks";

import {
  KernelCpuAccounting,
  type KernelCpuProcess,
  type KernelCpuSnapshot,
  type KernelCpuSliceOwner,
} from "./KernelCpuAccounting.ts";

type CpuMode = "user" | "system";

interface ScopeFrame {
  readonly mode: CpuMode;
  runnable: boolean;
  closed: boolean;
}

interface ExecutionState {
  readonly process: KernelCpuProcessExecution;
  readonly frames: ScopeFrame[];
}

const executionContexts = new NodeAsyncHooks.AsyncLocalStorage<ExecutionState>();
const noOp = () => {};
const processChecks = new WeakMap<KernelCpuProcessExecution, () => void>();
const executionOwners = new WeakMap<KernelCpuProcessExecution, ExecutionOwner>();
const executionMeters = new WeakMap<KernelCpuExecution, ExecutionOwner>();

interface ExecutionOwner {
  readonly states: Set<ExecutionState>;
  readonly meter: ReturnType<KernelCpuAccounting["createExecutionMeter"]>;
}

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
    processChecks.set(this, () => this.#assertUsable());
    executionOwners.set(this, executionMeters.get(execution)!);
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
    const states = new Set<ExecutionState>();
    executionMeters.set(this, {
      states,
      meter: accounting.createExecutionMeter(
        () => {
          const state = executionContexts.getStore();
          return state && states.has(state) ? scopeOwner(state) : undefined;
        },
        (pid) => [...states].some((state) => state.process.pid === pid),
      ),
    });
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
    processChecks.get(process)!();
    const current = executionContexts.getStore();
    if (current?.process === process) return run();
    const owner = executionMeters.get(this)!;
    const previous =
      current && executionOwners.get(current.process) === owner ? current : undefined;
    if (previous) owner.meter.checkpoint(scopeOwner(previous));
    const state: ExecutionState = { process, frames: [] };
    try {
      return executionContexts.run(state, run);
    } finally {
      if (previous) {
        try {
          if (state.frames.length !== 0) owner.meter.checkpoint(scopeOwner(state));
        } finally {
          selectOwner(previous);
        }
      }
    }
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
  let result: T;
  try {
    result = state.process.runSystem(run);
  } catch (error) {
    resume(false);
    throw error;
  }
  resume();
  return result;
}

/** Runs generator steps as system work while leaving each yielded Promise uncharged. */
export async function runCurrentKernelCpuAsyncSystemImport<T>(
  run: (runSystem: <V>(step: () => V) => V) => T | PromiseLike<T>,
): Promise<T> {
  const state = executionContexts.getStore();
  if (!state) return await run((step) => step());
  const resume = pauseState(state);
  try {
    let result: Promise<T>;
    try {
      const leaveSystem = enterScope(state, "system");
      try {
        result = Promise.resolve(run((step) => runCurrentKernelCpuSystem(step)));
        // Leaving can throw after work has started; keep its rejection owned.
        void result.catch(() => undefined);
      } finally {
        leaveSystem();
      }
    } catch (error) {
      resume(false);
      throw error;
    }
    const value = await result;
    try {
      return state.process.runSystem(() => value);
    } catch (error) {
      resume(false);
      throw error;
    }
  } finally {
    resume();
  }
}

/** Wraps host imports whose blocking paths explicitly pause their current CPU scope. */
export async function runCurrentKernelCpuAwaitableSystemImport<T>(
  run: () => T | PromiseLike<T>,
): Promise<T> {
  const state = executionContexts.getStore();
  if (!state) return await run();
  const resumeUser = pauseState(state);
  let leaveSystem: () => void;
  try {
    leaveSystem = enterScope(state, "system");
  } catch (error) {
    resumeUser(false);
    throw error;
  }
  try {
    return await run();
  } finally {
    leaveAndResume(leaveSystem, resumeUser);
  }
}

function leaveAndResume(leave: () => void, resume: (observe?: boolean) => void) {
  try {
    leave();
  } catch (error) {
    resume(false);
    throw error;
  }
  resume();
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
  const owner = executionOwners.get(state.process)!;
  owner.meter.checkpoint(scopeOwner(state));
  const frame: ScopeFrame = { mode, runnable: true, closed: false };
  state.frames.push(frame);
  owner.states.add(state);
  selectOwner(state);
  return () => {
    if (frame.closed) throw new Error("CPU execution scope has already been left");
    if (state.frames.at(-1) !== frame) {
      throw new Error("CPU execution scopes must be left in reverse entry order");
    }
    try {
      owner.meter.checkpoint(scopeOwner(state));
    } finally {
      frame.closed = true;
      state.frames.pop();
      if (state.frames.length === 0) owner.states.delete(state);
      selectOwner(state);
    }
  };
}

function pauseState(state: ExecutionState): (observe?: boolean) => void {
  const frame = state.frames.at(-1);
  if (!frame?.runnable) return noOp;
  const owner = executionOwners.get(state.process)!;
  owner.meter.checkpoint(scopeOwner(state));
  frame.runnable = false;
  selectOwner(state);
  let resumed = false;
  return (observe = true) => {
    if (resumed || frame.closed) return;
    if (state.frames.at(-1) !== frame || frame.runnable) return;
    try {
      if (observe) owner.meter.checkpoint(scopeOwner(state));
    } finally {
      frame.runnable = true;
      selectOwner(state);
      resumed = true;
    }
  };
}

function scopeOwner(state: ExecutionState): KernelCpuSliceOwner | undefined {
  const frame = state.frames.at(-1);
  return frame?.runnable ? { processId: state.process.pid, mode: frame.mode } : undefined;
}

function selectOwner(state: ExecutionState) {
  const owner = executionOwners.get(state.process)!;
  let next = scopeOwner(state);
  if (!next) {
    for (const candidate of owner.states) {
      next = scopeOwner(candidate);
      if (next) break;
    }
  }
  // Promise finalizers can select siblings before either user continuation runs.
  // Selection never charges time; the next explicit boundary identifies its owner.
  owner.meter.select(next);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}
