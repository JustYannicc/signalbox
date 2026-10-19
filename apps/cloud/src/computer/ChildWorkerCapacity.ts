export class ChildWorkerLimitError extends Error {
  readonly code = "RESOURCE_LIMIT";
  constructor() {
    super("Command capacity is full");
    this.name = "ChildWorkerLimitError";
  }
}

export interface ChildWorkerPermit {
  release(): void;
}

const childWorkerReservationBrand: unique symbol = Symbol("ChildWorkerReservation");
const childWorkerReservationIssuer = Symbol("ChildWorkerReservationIssuer");
const childWorkerReservations = new WeakSet<object>();

export interface ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand;
  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export function isChildWorkerReservation(value: unknown): value is ChildWorkerReservation {
  return typeof value === "object" && value !== null && childWorkerReservations.has(value);
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

  tryAcquire(signal: AbortSignal): ChildWorkerPermit | undefined {
    return this.#tryAcquire(signal);
  }

  tryReserve(signal: AbortSignal): ChildWorkerReservation | undefined {
    const permit = this.#tryAcquire(signal);
    return permit === undefined
      ? undefined
      : new ChildWorkerReservationImpl(childWorkerReservationIssuer, permit);
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    // RPC callbacks can depend on a live worker. Waiting here could require its own ancestor to finish.
    const permit = this.#tryAcquire(signal);
    if (permit === undefined) throw new ChildWorkerLimitError();
    try {
      return await work();
    } finally {
      permit.release();
    }
  }

  #tryAcquire(signal: AbortSignal): ChildWorkerPermit | undefined {
    signal.throwIfAborted();
    if (this.#active >= this.limit || this.#waiters.length > 0) return undefined;
    this.#active++;
    return this.#makePermit();
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

class ChildWorkerReservationImpl implements ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand =
    childWorkerReservationBrand;
  #state: "unconsumed" | "consumed" | "cancelled" | "settled" = "unconsumed";
  #released = false;
  readonly #permit: ChildWorkerPermit;

  constructor(issuer: typeof childWorkerReservationIssuer, permit: ChildWorkerPermit) {
    if (issuer !== childWorkerReservationIssuer) {
      throw new TypeError("Child worker reservations can only be issued by capacity");
    }
    this.#permit = permit;
    childWorkerReservations.add(this);
    Object.freeze(this);
  }

  readonly run = <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    if (this.#state !== "unconsumed") {
      return Promise.reject(new Error("Child worker reservation is no longer available"));
    }
    this.#state = "consumed";

    try {
      signal.throwIfAborted();
    } catch (error) {
      this.#settle();
      return Promise.reject(error);
    }

    let result: Promise<T>;
    try {
      result = Promise.resolve(work());
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => this.#settle());
  };

  readonly cancel = (): void => {
    if (this.#state !== "unconsumed") return;
    this.#state = "cancelled";
    this.#release();
  };

  #settle(): void {
    this.#state = "settled";
    this.#release();
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#permit.release();
  }
}
