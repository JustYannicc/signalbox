interface Waiter {
  readonly signal: AbortSignal;
  readonly canAdmit: () => boolean;
  readonly grant: () => Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  granting: boolean;
}

export class ProcessSlotQueue {
  #tail = Promise.resolve();
  #pumping = false;
  #wakeAgain = false;
  readonly #waiters = new Set<Waiter>();
  #cancelQuantum: (() => void) | undefined;
  #pressured: Waiter | undefined;
  readonly #scheduleQuantum: (callback: () => void) => () => void;
  readonly #pressure: () => void;

  constructor(scheduleQuantum: (callback: () => void) => () => void, pressure: () => void) {
    this.#scheduleQuantum = scheduleQuantum;
    this.#pressure = pressure;
  }

  get waiting() {
    return this.#waiters.size;
  }

  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  enqueue<T>(signal: AbortSignal, canAdmit: () => boolean, grant: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        reject,
        canAdmit,
        granting: false,
        grant: async () => {
          resolve(await grant());
        },
        onAbort: () => {
          // A save in progress must finish its rollback before abort can become visible.
          if (waiter.granting) return;
          this.#remove(waiter);
          reject(signal.reason);
          this.wake();
        },
      };
      this.#waiters.add(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
      this.wake();
    });
  }

  wake(): void {
    if (this.#pumping) {
      this.#wakeAgain = true;
      return;
    }
    if (this.#waiters.size === 0) return;
    this.#pumping = true;
    this.#wakeAgain = false;
    void this.serial(async () => {
      for (const waiter of this.#waiters) {
        try {
          waiter.signal.throwIfAborted();
          // Byte room belongs to each isolate. An oversized holder cannot block unrelated slots.
          if (!waiter.canAdmit()) continue;
          waiter.granting = true;
          await waiter.grant();
          this.#remove(waiter);
        } catch (error) {
          this.#remove(waiter);
          waiter.reject(error);
        }
        return true;
      }
      const first = this.#waiters.values().next().value;
      if (first !== undefined) this.#schedulePressure(first);
      return false;
    }).then((progress) => {
      this.#pumping = false;
      if (progress || this.#wakeAgain) this.wake();
    });
  }

  #remove(waiter: Waiter): void {
    this.#waiters.delete(waiter);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (this.#pressured === waiter) {
      this.#cancelQuantum?.();
      this.#cancelQuantum = undefined;
      this.#pressured = undefined;
    }
  }

  #schedulePressure(waiter: Waiter): void {
    if (this.#pressured === waiter) return;
    this.#cancelQuantum?.();
    this.#pressured = waiter;
    this.#cancelQuantum = this.#scheduleQuantum(() => {
      this.#cancelQuantum = undefined;
      if (this.#waiters.has(waiter)) this.#pressure();
    });
  }
}
