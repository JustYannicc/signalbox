export interface ChildWorkerPermit {
  release(): void;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (permit: ChildWorkerPermit) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
  state: "queued" | "granted" | "cancelled";
}

export class ChildWorkerCapacity {
  readonly limit: number;
  #active = 0;
  #draining = false;
  #waiters: Waiter[] = [];

  constructor(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw new RangeError("Child worker capacity must be an integer from 1 to 10");
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  acquire(signal: AbortSignal): Promise<ChildWorkerPermit> {
    if (signal.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = () => {
        if (waiter.state !== "queued") return;
        waiter.state = "cancelled";
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        waiter.reject(signal.reason);
        this.#drain();
      };
      waiter = { signal, resolve, reject, onAbort, state: "queued" };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });

      // A custom signal can dispatch synchronously while installing its listener.
      if (signal.aborted) onAbort();
      if (waiter.state !== "queued") signal.removeEventListener("abort", onAbort);
      this.#drain();
    });
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const permit = await this.acquire(signal);
    try {
      return await work();
    } finally {
      permit.release();
    }
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#active < this.limit) {
        const waiter = this.#waiters.shift();
        if (!waiter) return;
        if (waiter.state !== "queued") continue;

        waiter.state = "granted";
        this.#active += 1;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.#makePermit());
      }
    } finally {
      this.#draining = false;
    }
  }

  #makePermit(): ChildWorkerPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#drain();
      },
    };
  }
}
