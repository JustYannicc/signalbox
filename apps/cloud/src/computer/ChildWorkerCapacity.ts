import type { KernelHandle } from "../kernel/KernelAbi.ts";
import type { KernelProcessTable } from "../kernel/KernelProcessTable.ts";

export interface ChildWorkerPermit {
  release(): void;
}

export interface ChildWorkerRequester {
  readonly processes: Pick<KernelProcessTable, "workerOwner" | "setWorkerOwner">;
  readonly process: KernelHandle<"process"> | undefined;
}

const childWorkerReservationBrand: unique symbol = Symbol("ChildWorkerReservation");
const childWorkerReservationIssuer = Symbol("ChildWorkerReservationIssuer");
const childWorkerReservations = new WeakSet<object>();

export interface ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand;
  run<T>(signal: AbortSignal, work: () => Promise<T>, requester: ChildWorkerRequester): Promise<T>;
  cancel(): void;
}

export function isChildWorkerReservation(value: unknown): value is ChildWorkerReservation {
  return typeof value === "object" && value !== null && childWorkerReservations.has(value);
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (permit: InternalPermit) => void;
  readonly onAbort: () => void;
  state: "queued" | "granted" | "cancelled";
}

// Each child uses about 0.17 MiB of harness-side kernel state. 64 uses about 11 MiB,
// within the harness's headroom after boot.
const DEFAULT_HARD_LIMIT = 64;

interface InternalPermit extends ChildWorkerPermit {
  bind(requester: ChildWorkerRequester): void;
}

export class ChildWorkerCapacity {
  readonly limit: number;
  readonly hardLimit: number;
  #active = 0;
  #draining = false;
  readonly #nested = new Set<Waiter>();
  readonly #roots = new Set<Waiter>();
  readonly #owners = new WeakSet<object>();

  constructor(
    limit = 10,
    { hardLimit = Math.max(DEFAULT_HARD_LIMIT, limit) }: { readonly hardLimit?: number } = {},
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Child worker capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(hardLimit) || hardLimit < limit) {
      throw new RangeError("Child worker hard capacity must be a safe integer at least the limit");
    }
    this.limit = limit;
    this.hardLimit = hardLimit;
  }

  get active(): number {
    return this.#active;
  }

  /** The requester selects queue priority only; run or reservation.run binds worker ownership. */
  acquire(signal: AbortSignal, requester?: ChildWorkerRequester): Promise<ChildWorkerPermit> {
    return this.#acquire(signal, requester);
  }

  #acquire(signal: AbortSignal, requester?: ChildWorkerRequester): Promise<InternalPermit> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#nested.size === 0 && this.#roots.size === 0 && this.#active < this.limit) {
      this.#active++;
      return Promise.resolve(this.#makePermit());
    }

    const owner = requester?.processes.workerOwner(requester.process);
    const queue =
      owner?.status === "ok" && owner.value !== undefined && this.#owners.has(owner.value)
        ? this.#nested
        : this.#roots;
    return new Promise<InternalPermit>((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = () => {
        if (waiter.state !== "queued") return;
        waiter.state = "cancelled";
        queue.delete(waiter);
        reject(signal.reason);
      };
      waiter = { signal, resolve, onAbort, state: "queued" };
      queue.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });

      // A custom signal can dispatch synchronously while installing its listener.
      if (signal.aborted) onAbort();
      this.#drain();
    });
  }

  async reserve(
    signal: AbortSignal,
    requester: ChildWorkerRequester,
  ): Promise<ChildWorkerReservation> {
    const permit = await this.#acquire(signal, requester);
    return new ChildWorkerReservationImpl(childWorkerReservationIssuer, permit);
  }

  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    requester: ChildWorkerRequester,
  ): Promise<T> {
    const permit = await this.#acquire(signal, requester);
    try {
      signal.throwIfAborted();
      permit.bind(requester);
      return await work();
    } finally {
      permit.release();
    }
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#active < this.hardLimit) {
        // Descendants must be able to finish before the roots holding their permits can exit.
        const queue = this.#nested.size > 0 ? this.#nested : this.#roots;
        if (queue === this.#roots && this.#active >= this.limit) return;
        const waiter = queue.values().next().value;
        if (waiter === undefined) return;
        queue.delete(waiter);
        waiter.state = "granted";
        this.#active++;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.#makePermit());
      }
    } finally {
      this.#draining = false;
    }
  }

  #makePermit(): InternalPermit {
    let released = false;
    let owner: object | undefined;
    return {
      bind: (requester) => {
        if (released || owner !== undefined) {
          throw new Error("Child worker permit was already bound or released");
        }
        if (requester.process === undefined) {
          throw new Error("Child worker requester process is unavailable");
        }
        const token = Object.freeze({});
        const assigned = requester.processes.setWorkerOwner(requester.process, token);
        if (assigned.status !== "ok")
          throw new Error("Child worker requester process is unavailable");
        owner = token;
        this.#owners.add(token);
      },
      release: () => {
        if (released) return;
        released = true;
        if (owner !== undefined) this.#owners.delete(owner);
        this.#active--;
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
  readonly #permit: InternalPermit;

  constructor(issuer: typeof childWorkerReservationIssuer, permit: InternalPermit) {
    if (issuer !== childWorkerReservationIssuer) {
      throw new TypeError("Child worker reservations can only be issued by capacity");
    }
    this.#permit = permit;
    childWorkerReservations.add(this);
    Object.freeze(this);
  }

  readonly run = <T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    requester: ChildWorkerRequester,
  ): Promise<T> => {
    if (this.#state !== "unconsumed") {
      return Promise.reject(new Error("Child worker reservation is no longer available"));
    }
    this.#state = "consumed";

    try {
      signal.throwIfAborted();
      this.#permit.bind(requester);
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
