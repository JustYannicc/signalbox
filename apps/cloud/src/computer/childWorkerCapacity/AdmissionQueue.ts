import type {
  ProcessSlotLease,
  ProcessSlotPermit,
  ProcessSlotPressure,
  ProcessSlotRequest,
  ProcessSlots,
  ProcessSlotsOptions,
} from "../ProcessSlots.ts";
import type { ChildWorkerPermitHooks } from "./Execution.ts";
import type {
  InternalChildWorkerPermit,
  ChildWorkerSiblingFamily,
  ChildWorkerRequester,
  ChildWorkerSlotRequest,
} from "./types.ts";

interface Waiter {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  readonly order: number;
  readonly siblingFamily: ChildWorkerSiblingFamily | undefined;
  resolve?: (permit: InternalChildWorkerPermit) => void;
  reject?: (error: unknown) => void;
  result?: Promise<InternalChildWorkerPermit>;
  code?: ChildWorkerSlotRequest;
  request?: ProcessSlotRequest;
  readonly onAbort: () => void;
  state: "queued" | "submitted" | "done";
  occupiesSlot: boolean;
  occupiesSiblingFamily: boolean;
  unplaceable: boolean;
  failure?: unknown;
}

export interface QueuedChildWorkerAdmission {
  acquire(code: ChildWorkerSlotRequest): Promise<InternalChildWorkerPermit>;
  cancel(): void;
}

export interface ChildWorkerAdmissionQueueOptions {
  readonly limit: number;
  readonly owner: string;
  readonly residentByteLimit: number;
  readonly slots: Promise<ProcessSlots>;
  readonly scheduleQuantum: ProcessSlotsOptions["scheduleQuantum"];
  readonly onCapacityPressure: (adapterWaiters: number) => void;
  readonly isNested: (requester: ChildWorkerRequester | undefined) => boolean;
  readonly siblingFamily: (
    requester: ChildWorkerRequester | undefined,
  ) => ChildWorkerSiblingFamily | undefined;
  readonly makePermit: (
    slots: ProcessSlots,
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    hooks: Omit<ChildWorkerPermitHooks, "bind">,
    residentByteLimit: number,
  ) => InternalChildWorkerPermit;
}

/** Orders callers before ProcessSlots so its public FIFO queue never hides later descendants. */
export class ChildWorkerAdmissionQueue {
  readonly #options: ChildWorkerAdmissionQueueOptions;
  readonly #nested = new Set<Waiter>();
  readonly #roots = new Set<Waiter>();
  readonly #pending = new Set<Waiter>();
  readonly #siblingSlots = new WeakMap<object, Map<number, number>>();
  #used = 0;
  #terminating = 0;
  #nextOrder = 0;
  #draining = false;
  #failure: { readonly error: unknown } | undefined;
  #cancelQuantum: (() => void) | undefined;

  constructor(options: ChildWorkerAdmissionQueueOptions) {
    this.#options = options;
  }

  get active(): number {
    return this.#used - this.#terminating;
  }

  get waiting(): number {
    return this.#nested.size + this.#roots.size + this.#pending.size;
  }

  enqueue(
    signal: AbortSignal,
    requester: ChildWorkerRequester | undefined,
  ): QueuedChildWorkerAdmission {
    const controller = new AbortController();
    const ownedSignal = AbortSignal.any([signal, controller.signal]);
    let waiter!: Waiter;
    const onAbort = () => {
      if (waiter.state !== "queued") return;
      waiter.state = "done";
      waiter.failure = ownedSignal.reason;
      this.#roots.delete(waiter);
      this.#nested.delete(waiter);
      ownedSignal.removeEventListener("abort", onAbort);
      waiter.reject?.(ownedSignal.reason);
      this.#drain();
    };
    waiter = {
      signal: ownedSignal,
      controller,
      order: this.#nextOrder++,
      siblingFamily: this.#options.siblingFamily(requester),
      onAbort,
      state: "queued",
      occupiesSlot: false,
      occupiesSiblingFamily: false,
      unplaceable: false,
    };
    const queue = this.#queueFor(requester);
    if (ownedSignal.aborted) {
      waiter.state = "done";
      waiter.failure = ownedSignal.reason;
    } else if (this.#failure !== undefined) {
      waiter.state = "done";
      waiter.failure = this.#failure.error;
    } else {
      queue.add(waiter);
      ownedSignal.addEventListener("abort", onAbort, { once: true });
      if (ownedSignal.aborted) onAbort();
      this.#drain();
    }

    return {
      acquire: (code) => this.#acquire(waiter, code),
      cancel: () => {
        if (waiter.state === "done") return;
        controller.abort(new Error("Child worker admission ticket cancelled"));
        if (waiter.state === "queued") onAbort();
      },
    };
  }

  handlePressure(pressure: ProcessSlotPressure): void {
    if (pressure.kind !== "unplaceable" || !("request" in pressure)) return;
    const waiter = [...this.#pending].find(
      (candidate) =>
        candidate.request !== undefined && sameRequest(candidate.request, pressure.request),
    );
    if (waiter === undefined || waiter.unplaceable) return;
    waiter.unplaceable = true;
    if (waiter.occupiesSlot) {
      waiter.occupiesSlot = false;
      this.#used--;
      this.#retireSiblingFamily(waiter);
      this.#drain();
    }
  }

  fence(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = { error };
    this.#cancelPressure();
    for (const queue of [this.#nested, this.#roots]) {
      for (const waiter of queue) {
        waiter.state = "done";
        waiter.failure = error;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.controller.abort(error);
        waiter.reject?.(error);
      }
      queue.clear();
    }
  }

  #queueFor(requester: ChildWorkerRequester | undefined): Set<Waiter> {
    if (this.#used < this.#options.limit && this.#nested.size === 0 && this.#roots.size === 0) {
      return this.#roots;
    }
    return this.#options.isNested(requester) ? this.#nested : this.#roots;
  }

  #acquire(waiter: Waiter, code: ChildWorkerSlotRequest): Promise<InternalChildWorkerPermit> {
    if (waiter.result !== undefined) {
      return Promise.reject(new TypeError("Child worker admission ticket was already reserved"));
    }
    if (waiter.state === "done") return Promise.reject(waiter.failure);
    if (waiter.signal.aborted) {
      waiter.onAbort();
      return Promise.reject(waiter.failure ?? waiter.signal.reason);
    }
    waiter.code = code;
    waiter.request = Object.freeze({
      owner: this.#options.owner,
      codeId: code.codeId,
      residentBytes: code.residentBytes,
      signal: waiter.signal,
    });
    waiter.result = new Promise<InternalChildWorkerPermit>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    this.#drain();
    return waiter.result;
  }

  #drain(): void {
    if (this.#draining || this.#failure !== undefined) return;
    this.#draining = true;
    try {
      // Unplaceable work reaches host pressure but never claims an execution slot.
      for (const queue of [this.#nested, this.#roots]) {
        for (const waiter of queue) {
          if (
            waiter.code === undefined ||
            waiter.code.residentBytes <= this.#options.residentByteLimit
          )
            continue;
          queue.delete(waiter);
          if (waiter.signal.aborted) {
            waiter.state = "done";
            waiter.signal.removeEventListener("abort", waiter.onAbort);
            waiter.reject?.(waiter.signal.reason);
            continue;
          }
          waiter.state = "submitted";
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          this.#pending.add(waiter);
          void this.#submit(waiter);
        }
      }
      while (this.#used < this.#options.limit) {
        const next = this.#nextWaiter();
        if (next === undefined) return;
        const { queue, waiter } = next;
        if (waiter.code === undefined) return;
        queue.delete(waiter);
        if (waiter.signal.aborted) {
          waiter.state = "done";
          waiter.signal.removeEventListener("abort", waiter.onAbort);
          waiter.reject?.(waiter.signal.reason);
          continue;
        }
        waiter.state = "submitted";
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.occupiesSlot = true;
        this.#used++;
        this.#occupySiblingFamily(waiter);
        this.#pending.add(waiter);
        void this.#submit(waiter);
      }
    } finally {
      this.#draining = false;
      this.#refreshPressure();
    }
  }

  #refreshPressure(): void {
    const blocked =
      this.#failure === undefined &&
      this.#used >= this.#options.limit &&
      (this.#nested.size > 0 || this.#roots.size > 0);
    if (!blocked) {
      this.#cancelPressure();
      return;
    }
    if (this.#cancelQuantum !== undefined) return;

    let scheduling = true;
    let firedDuringSchedule = false;
    try {
      const cancel = this.#options.scheduleQuantum(() => {
        if (scheduling) firedDuringSchedule = true;
        this.#cancelQuantum = undefined;
        if (this.#hasCapacityWaiters()) {
          this.#options.onCapacityPressure(this.waiting);
        }
        if (!scheduling) this.#refreshPressure();
      });
      scheduling = false;
      if (!firedDuringSchedule) this.#cancelQuantum = cancel;
    } catch {
      scheduling = false;
      this.#cancelQuantum = undefined;
    }
  }

  #hasCapacityWaiters(): boolean {
    return (
      this.#failure === undefined &&
      this.#used >= this.#options.limit &&
      (this.#nested.size > 0 || this.#roots.size > 0)
    );
  }

  #nextWaiter(): { readonly queue: Set<Waiter>; readonly waiter: Waiter } | undefined {
    // Active siblings win first; existing nested ownership and arrival order break ties.
    let selected:
      | {
          readonly queue: Set<Waiter>;
          readonly waiter: Waiter;
          readonly hasSibling: boolean;
          readonly isNested: boolean;
        }
      | undefined;
    for (const queue of [this.#nested, this.#roots]) {
      for (const waiter of queue) {
        const candidate = {
          queue,
          waiter,
          hasSibling: this.#hasSiblingSlot(waiter.siblingFamily),
          isNested: queue === this.#nested,
        };
        if (
          selected === undefined ||
          Number(candidate.hasSibling) > Number(selected.hasSibling) ||
          (candidate.hasSibling === selected.hasSibling &&
            Number(candidate.isNested) > Number(selected.isNested)) ||
          (candidate.hasSibling === selected.hasSibling &&
            candidate.isNested === selected.isNested &&
            candidate.waiter.order < selected.waiter.order)
        ) {
          selected = candidate;
        }
      }
    }
    return selected;
  }

  #hasSiblingSlot(family: ChildWorkerSiblingFamily | undefined): boolean {
    if (family === undefined) return false;
    return (this.#siblingSlots.get(family.processes)?.get(family.parentPid) ?? 0) > 0;
  }

  #occupySiblingFamily(waiter: Waiter): void {
    const family = waiter.siblingFamily;
    if (family === undefined || waiter.occupiesSiblingFamily) return;
    let families = this.#siblingSlots.get(family.processes);
    if (families === undefined) {
      families = new Map();
      this.#siblingSlots.set(family.processes, families);
    }
    families.set(family.parentPid, (families.get(family.parentPid) ?? 0) + 1);
    waiter.occupiesSiblingFamily = true;
  }

  #retireSiblingFamily(waiter: Waiter): void {
    const family = waiter.siblingFamily;
    if (family === undefined || !waiter.occupiesSiblingFamily) return;
    waiter.occupiesSiblingFamily = false;
    const families = this.#siblingSlots.get(family.processes);
    const count = families?.get(family.parentPid);
    if (families === undefined || count === undefined) return;
    if (count <= 1) families.delete(family.parentPid);
    else families.set(family.parentPid, count - 1);
  }

  #cancelPressure(): void {
    const cancel = this.#cancelQuantum;
    this.#cancelQuantum = undefined;
    try {
      cancel?.();
    } catch {
      // A scheduler's cancellation callback cannot interrupt admission cleanup.
    }
  }

  async #submit(waiter: Waiter): Promise<void> {
    let slots: ProcessSlots;
    try {
      slots = await this.#options.slots;
      const result = await slots.acquire(waiter.request!);
      this.#pending.delete(waiter);
      if (!waiter.occupiesSlot || waiter.unplaceable) {
        this.#retireSiblingFamily(waiter);
        await slots.release(result.lease, { acknowledged: true });
        const error = new Error("ProcessSlots admitted a request marked unplaceable");
        waiter.state = "done";
        waiter.reject?.(error);
        this.fence(error);
        return;
      }
      waiter.state = "done";
      waiter.resolve?.(
        this.#options.makePermit(
          slots,
          result.lease,
          result.permit,
          {
            ending: () => {
              this.#terminating++;
            },
            ended: () => {
              this.#terminating--;
              this.#used--;
              this.#retireSiblingFamily(waiter);
              this.#drain();
            },
            failed: () => {
              this.#terminating--;
            },
          },
          this.#options.residentByteLimit,
        ),
      );
    } catch (error) {
      this.#pending.delete(waiter);
      this.#retireSiblingFamily(waiter);
      if (waiter.occupiesSlot) {
        waiter.occupiesSlot = false;
        this.#used--;
      }
      waiter.state = "done";
      waiter.reject?.(error);
      this.#drain();
    }
  }
}

function sameRequest(left: ProcessSlotRequest, right: ProcessSlotRequest): boolean {
  return (
    left.owner === right.owner &&
    left.codeId === right.codeId &&
    left.residentBytes === right.residentBytes &&
    left.signal === right.signal
  );
}
