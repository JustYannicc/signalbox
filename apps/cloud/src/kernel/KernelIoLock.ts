import { currentKernelIoMode, currentKernelSignal } from "./process/KernelExecution.ts";
import { notifyKernelSuspension } from "./KernelSuspension.ts";
import { complete, type WasiCall } from "./wasi/internal_wasi_calls.ts";
import { WasiError } from "./wasi/internal_wasi_memory.ts";

interface Waiter {
  readonly owner: object;
  readonly ready: ReturnType<typeof Promise.withResolvers<void>>;
  granted: boolean;
}

/** A guest syscall can keep its lock while the child sends its next bounded chunk. */
export class KernelIoLock {
  #owner: object | undefined;
  #waiters: Waiter[] = [];
  readonly #idle: () => void;

  constructor(idle: () => void = () => {}) {
    this.#idle = idle;
  }

  *acquire(owner: object, signal?: AbortSignal): WasiCall<() => void> {
    if (signal?.aborted) throw new WasiError(11);
    const release = this.tryAcquire(owner);
    if (release !== undefined) return release;

    // Inline programs cannot suspend behind another process's continuation.
    if (currentKernelIoMode() === "sync") return () => {};
    const waiter: Waiter = { owner, ready: Promise.withResolvers<void>(), granted: false };
    this.#waiters.push(waiter);
    const abort = () => waiter.ready.reject(new WasiError(11));
    signal?.addEventListener("abort", abort, { once: true });
    let acquired = false;
    try {
      notifyKernelSuspension();
      yield waiter.ready.promise;
      if (signal?.aborted) throw new WasiError(11);
      acquired = true;
      return this.#release(owner);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!acquired) {
        if (waiter.granted) this.#release(owner)();
        else {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
        }
      }
    }
  }

  tryAcquire(owner: object): (() => void) | undefined {
    if (this.#owner === owner) return () => {};
    if (this.#owner !== undefined) return undefined;
    this.#owner = owner;
    return this.#release(owner);
  }

  *with<T>(operation: () => WasiCall<T>, owner: object = {}): WasiCall<T> {
    const release = yield* this.acquire(owner);
    try {
      return yield* operation();
    } finally {
      release();
    }
  }

  #release(owner: object) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#owner !== owner) throw new Error("I/O lock ownership changed before release");
      const waiter = this.#waiters.shift();
      this.#owner = waiter?.owner;
      if (waiter === undefined) this.#idle();
      else {
        waiter.granted = true;
        waiter.ready.resolve();
      }
    };
  }
}

const inodeLocks = new WeakMap<object, Map<bigint, KernelIoLock>>();

/** Storage identity keeps equal inode numbers on unrelated mounts independent. */
export function kernelFileWriteLock(storage: object, inode: bigint) {
  let locks = inodeLocks.get(storage);
  if (locks === undefined) {
    locks = new Map();
    inodeLocks.set(storage, locks);
  }
  let lock = locks.get(inode);
  if (lock === undefined) {
    const entries = locks;
    lock = new KernelIoLock(() => entries.delete(inode));
    entries.set(inode, lock);
  }
  return lock;
}

/** Inline execution cannot suspend behind another process's continuation. */
export function* acquireKernelFileWrite(
  storage: object,
  inode: bigint,
  owner: object,
  signal = currentKernelSignal(),
): WasiCall<() => void> {
  const lock = kernelFileWriteLock(storage, inode);
  if (signal?.aborted) throw new WasiError(11);
  // Sync callers retain their original immediate semantics and may interleave with child chunks.
  if (currentKernelIoMode() === "sync") return lock.tryAcquire(owner) ?? (() => {});
  return yield* lock.acquire(owner, signal);
}

export function* withKernelFileWrite<T>(
  storage: object,
  inode: bigint,
  operation: () => T | Promise<T>,
): WasiCall<T> {
  const release = yield* acquireKernelFileWrite(storage, inode, {});
  try {
    return yield* complete(operation());
  } finally {
    release();
  }
}
