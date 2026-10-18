export interface KernelCpuSnapshot {
  readonly userNs: bigint;
  readonly systemNs: bigint;
}

export interface KernelCpuProcess {
  /** Starts a runnable slice. Leave it before yielding or waiting for I/O. */
  enterUser(): () => void;
  /** Starts a synchronous kernel syscall slice. */
  enterSystem(): () => void;
  /** Wraps synchronous work and rejects Promise-like results. */
  runUser<T>(run: () => T): T;
  /** Wraps synchronous syscall work and rejects Promise-like results. */
  runSystem<T>(run: () => T): T;
  /** Includes the current interval when this process is the active scope. */
  snapshot(): KernelCpuSnapshot;
  /** Releases the process record after all of its scopes have been left. */
  dispose(): void;
}

type CpuMode = "user" | "system";

interface ProcessRecord {
  userNs: bigint;
  systemNs: bigint;
}

interface ActiveScope {
  readonly processId: number;
  readonly mode: CpuMode;
  startedAt: bigint;
}

const emptySnapshot = (): KernelCpuSnapshot => ({ userNs: 0n, systemNs: 0n });

const isPromiseLike = (value: unknown) =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof Reflect.get(value, "then") === "function";

/**
 * Accounts runnable logical-process time at explicit synchronous boundaries.
 * The supplied clock must return monotonic nanoseconds; regressions are clamped
 * to the last observed reading so counters never decrease. Zero deltas stay zero.
 */
export class KernelCpuAccounting {
  readonly #readClock: () => bigint;
  readonly #records = new Map<number, ProcessRecord>();
  readonly #handles = new Map<number, KernelCpuProcess>();
  readonly #scopes: Array<ActiveScope> = [];
  #lastObserved: bigint | undefined;

  constructor(readClock: () => bigint) {
    this.#readClock = readClock;
  }

  /** Returns the stable accounting handle for one logical process id. */
  forProcess(processId: number): KernelCpuProcess {
    this.#assertProcessId(processId);
    const existing = this.#handles.get(processId);
    if (existing) return existing;

    let disposed = false;
    const assertUsable = () => {
      if (disposed) throw new Error("CPU accounting handle is disposed");
    };
    const handle: KernelCpuProcess = {
      enterUser: () => {
        assertUsable();
        return this.#enter(processId, "user");
      },
      enterSystem: () => {
        assertUsable();
        return this.#enter(processId, "system");
      },
      runUser: <T>(run: () => T) => {
        assertUsable();
        return this.#run(processId, "user", run);
      },
      runSystem: <T>(run: () => T) => {
        assertUsable();
        return this.#run(processId, "system", run);
      },
      snapshot: () => {
        assertUsable();
        return this.#snapshot(processId);
      },
      dispose: () => {
        assertUsable();
        if (this.#scopes.some((scope) => scope.processId === processId)) {
          throw new Error("Cannot dispose CPU accounting while a process scope is open");
        }
        this.#records.delete(processId);
        this.#handles.delete(processId);
        disposed = true;
      },
    };
    this.#handles.set(processId, handle);
    return handle;
  }

  #assertProcessId(processId: number) {
    if (!Number.isSafeInteger(processId) || processId < 1) {
      throw new RangeError("processId must be a positive safe integer");
    }
  }

  #observeClock() {
    const observed = this.#readClock();
    if (typeof observed !== "bigint")
      throw new TypeError("CPU clock must return bigint nanoseconds");
    if (this.#lastObserved !== undefined && observed < this.#lastObserved) {
      return this.#lastObserved;
    }
    this.#lastObserved = observed;
    return observed;
  }

  #record(processId: number) {
    let record = this.#records.get(processId);
    if (!record) {
      record = { userNs: 0n, systemNs: 0n };
      this.#records.set(processId, record);
    }
    return record;
  }

  #settle(scope: ActiveScope, endedAt: bigint) {
    const elapsed = endedAt - scope.startedAt;
    if (elapsed <= 0n) return;
    const record = this.#record(scope.processId);
    if (scope.mode === "user") record.userNs += elapsed;
    else record.systemNs += elapsed;
  }

  #enter(processId: number, mode: CpuMode) {
    const startedAt = this.#observeClock();
    const previous = this.#scopes.at(-1);
    if (previous) this.#settle(previous, startedAt);

    const scope: ActiveScope = { processId, mode, startedAt };
    this.#scopes.push(scope);
    this.#record(processId);

    let left = false;
    return () => {
      if (left) throw new Error("CPU accounting scope has already been left");
      if (this.#scopes.at(-1) !== scope) {
        throw new Error("CPU accounting scopes must be left in reverse entry order");
      }

      let endedAt: bigint;
      let clockError: unknown;
      let clockFailed = false;
      try {
        endedAt = this.#observeClock();
      } catch (error) {
        endedAt = this.#lastObserved ?? scope.startedAt;
        clockError = error;
        clockFailed = true;
      }

      this.#settle(scope, endedAt);
      this.#scopes.pop();
      const resumed = this.#scopes.at(-1);
      if (resumed) resumed.startedAt = endedAt;
      left = true;
      if (clockFailed) throw clockError;
    };
  }

  #run<T>(processId: number, mode: CpuMode, run: () => T): T {
    const leave = this.#enter(processId, mode);
    let result: T;
    try {
      result = run();
    } catch (error) {
      leave();
      throw error;
    }
    leave();
    if (isPromiseLike(result)) {
      // The caller gets the contract error; don't leak an unhandled rejection as well.
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("CPU accounting helpers cannot wrap asynchronous work");
    }
    return result;
  }

  #snapshot(processId: number): KernelCpuSnapshot {
    const record = this.#records.get(processId);
    if (!record) return emptySnapshot();

    let userNs = record.userNs;
    let systemNs = record.systemNs;
    const active = this.#scopes.at(-1);
    if (active?.processId === processId) {
      const elapsed = this.#observeClock() - active.startedAt;
      if (active.mode === "user") userNs += elapsed;
      else systemNs += elapsed;
    }
    return { userNs, systemNs };
  }
}
