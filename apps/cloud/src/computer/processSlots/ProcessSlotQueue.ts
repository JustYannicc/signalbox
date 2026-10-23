import type { ProcessSlotBlocker } from "./ProcessSlotTypes.ts";

interface Waiter {
  readonly signal: AbortSignal;
  readonly status: () => "ready" | ProcessSlotBlocker;
  readonly grant: () => Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  granting: boolean;
  notified: boolean;
}

export class ProcessSlotQueue {
  #tail = Promise.resolve();
  #pumping = false;
  #wakeAgain = false;
  readonly #waiters = new Set<Waiter>();
  #cancelQuantum: (() => void) | undefined;
  readonly #scheduleQuantum: (callback: () => void) => () => void;
  readonly #pressure: (blocker: ProcessSlotBlocker) => void;

  constructor(
    scheduleQuantum: (callback: () => void) => () => void,
    pressure: (blocker: ProcessSlotBlocker) => void,
  ) {
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

  enqueue<T>(
    signal: AbortSignal,
    status: () => "ready" | ProcessSlotBlocker,
    grant: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        reject,
        status,
        granting: false,
        notified: false,
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
          if (waiter.status() !== "ready") continue;
          waiter.notified = false;
          waiter.granting = true;
          await waiter.grant();
          this.#remove(waiter);
        } catch (error) {
          this.#remove(waiter);
          waiter.reject(error);
        }
        return true;
      }
      this.#armPressure();
      return false;
    }).then(
      (progress) => this.#finish(progress),
      () => this.#finish(false),
    );
  }

  #finish(progress: boolean): void {
    this.#pumping = false;
    if (progress || this.#wakeAgain) this.wake();
  }

  #remove(waiter: Waiter): void {
    this.#waiters.delete(waiter);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (this.#waiters.size === 0) {
      const cancel = this.#cancelQuantum;
      this.#cancelQuantum = undefined;
      try {
        cancel?.();
      } catch {
        // A supervisor's cancellation callback cannot interrupt waiter cleanup.
      }
    }
  }

  #blocked(): { waiter: Waiter; blocker: ProcessSlotBlocker }[] {
    const blocked = [];
    for (const waiter of this.#waiters) {
      if (waiter.granting) continue;
      try {
        waiter.signal.throwIfAborted();
        const status = waiter.status();
        if (status === "ready") {
          waiter.notified = false;
          continue;
        }
        if (status.kind === "capacity") waiter.notified = false;
        blocked.push({ waiter, blocker: status });
      } catch (error) {
        this.#remove(waiter);
        waiter.reject(error);
      }
    }
    return blocked;
  }

  #armPressure(): void {
    if (this.#cancelQuantum !== undefined) return;
    if (
      !this.#blocked().some(
        ({ waiter, blocker }) => blocker.kind === "capacity" || !waiter.notified,
      )
    )
      return;
    try {
      this.#cancelQuantum = this.#scheduleQuantum(() => {
        this.#cancelQuantum = undefined;
        const blocked = this.#blocked();
        for (const { waiter, blocker } of blocked) {
          if (blocker.kind === "unplaceable" && !waiter.notified) {
            waiter.notified = true;
            this.#pressure(blocker);
          }
        }
        if (this.#blocked().some(({ blocker }) => blocker.kind === "capacity"))
          this.#pressure({ kind: "capacity" });
        this.#armPressure();
      });
    } catch {
      // A broken scheduler cannot poison permit admission; the next state change can retry it.
      this.#cancelQuantum = undefined;
    }
  }
}
