import type { KernelHandle } from "../kernel/KernelAbi.ts";
import type { KernelProcessTable } from "../kernel/KernelProcessTable.ts";

export interface ChildWorkerPermit {
  release(): void;
}

export interface ChildWorkerRequester {
  readonly processes: Pick<KernelProcessTable, "info" | "lookupPid">;
  /** The ancestry walk starts here, inclusive. */
  readonly process?: KernelHandle<"process"> | undefined;
}

const childWorkerReservationBrand: unique symbol = Symbol("ChildWorkerReservation");
const childWorkerReservationIssuer = Symbol("ChildWorkerReservationIssuer");
const childWorkerReservations = new WeakSet<object>();

export interface ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand;
  run<T>(signal: AbortSignal, work: () => Promise<T>, pid?: number): Promise<T>;
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

type ProcessTable = ChildWorkerRequester["processes"];
interface InternalPermit extends ChildWorkerPermit {
  bind(processes: ProcessTable, pid: number): void;
}

export class ChildWorkerCapacity {
  readonly limit: number;
  readonly hardLimit: number;
  #active = 0;
  #draining = false;
  readonly #nested = new Set<Waiter>();
  readonly #roots = new Set<Waiter>();
  readonly #holders = new WeakMap<ProcessTable, Map<number, number>>();

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

  acquire(signal: AbortSignal, requester?: ChildWorkerRequester): Promise<ChildWorkerPermit> {
    return this.#acquire(signal, requester);
  }

  #acquire(signal: AbortSignal, requester?: ChildWorkerRequester): Promise<InternalPermit> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#nested.size === 0 && this.#roots.size === 0 && this.#active < this.limit) {
      this.#active++;
      return Promise.resolve(this.#makePermit());
    }

    const holders = requester === undefined ? undefined : this.#holders.get(requester.processes);
    const queue =
      requester !== undefined && holders !== undefined && hasPermitAncestor(requester, holders)
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

  tryAcquire(signal: AbortSignal): ChildWorkerPermit | undefined {
    signal.throwIfAborted();
    if (this.#active >= this.limit || this.#nested.size > 0 || this.#roots.size > 0)
      return undefined;
    this.#active++;
    return this.#makePermit();
  }

  async reserve(
    signal: AbortSignal,
    requester?: ChildWorkerRequester,
  ): Promise<ChildWorkerReservation> {
    const permit = await this.#acquire(signal, requester);
    return new ChildWorkerReservationImpl(
      childWorkerReservationIssuer,
      permit,
      requester?.processes,
    );
  }

  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    requester?: ChildWorkerRequester,
  ): Promise<T> {
    const permit = await this.#acquire(signal, requester);
    try {
      signal.throwIfAborted();
      if (requester !== undefined) {
        const info = requester.processes.info(requester.process);
        if (info.status !== "ok") throw new Error("Child worker requester process is unavailable");
        permit.bind(requester.processes, info.value.pid);
      }
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
    let holder: { counts: Map<number, number>; pid: number } | undefined;
    return {
      bind: (processes, pid) => {
        if (released || holder !== undefined) {
          throw new Error("Child worker permit was already bound or released");
        }
        let counts = this.#holders.get(processes);
        if (counts === undefined) {
          counts = new Map();
          this.#holders.set(processes, counts);
        }
        holder = { counts, pid };
        // An exec replacement can briefly share its pid with the outgoing worker.
        counts.set(pid, (counts.get(pid) ?? 0) + 1);
      },
      release: () => {
        if (released) return;
        released = true;
        if (holder !== undefined) {
          const { counts, pid } = holder;
          const count = counts.get(pid)! - 1;
          if (count === 0) counts.delete(pid);
          else counts.set(pid, count);
        }
        this.#active--;
        this.#drain();
      },
    };
  }
}

function hasPermitAncestor(requester: ChildWorkerRequester, holders: ReadonlyMap<number, number>) {
  const initial = requester.processes.info(requester.process);
  if (initial.status !== "ok") return false;
  let info = initial.value;
  const visited = new Set<number>();
  for (;;) {
    const { pid, parentPid } = info;
    if (holders.has(pid)) return true;
    if (pid === 1 || visited.has(pid)) return false;
    visited.add(pid);
    const parent = requester.processes.lookupPid(parentPid);
    if (parent.status !== "ok") return false;
    info = parent.value.info;
  }
}

class ChildWorkerReservationImpl implements ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand =
    childWorkerReservationBrand;
  #state: "unconsumed" | "consumed" | "cancelled" | "settled" = "unconsumed";
  #released = false;
  readonly #permit: InternalPermit;
  readonly #processes: ProcessTable | undefined;

  constructor(
    issuer: typeof childWorkerReservationIssuer,
    permit: InternalPermit,
    processes?: ProcessTable,
  ) {
    if (issuer !== childWorkerReservationIssuer) {
      throw new TypeError("Child worker reservations can only be issued by capacity");
    }
    this.#permit = permit;
    this.#processes = processes;
    childWorkerReservations.add(this);
    Object.freeze(this);
  }

  readonly run = <T>(signal: AbortSignal, work: () => Promise<T>, pid?: number): Promise<T> => {
    if (this.#state !== "unconsumed") {
      return Promise.reject(new Error("Child worker reservation is no longer available"));
    }
    this.#state = "consumed";

    try {
      signal.throwIfAborted();
      if (pid !== undefined && this.#processes !== undefined) {
        this.#permit.bind(this.#processes, pid);
      }
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
