// @effect-diagnostics cryptoRandomUUID:off globalTimers:off - this portable Promise-based adapter creates per-instance namespaces and bounded pressure ticks without an Effect runtime.
import type {
  ProcessSlotLease,
  ProcessSlotPermit,
  ProcessSlotPressure,
  ProcessSlotStore,
  ProcessSlots,
  ProcessSlotsOptions,
} from "./ProcessSlots.ts";
import { createProcessSlots } from "./ProcessSlots.ts";
import { CommandProcessSlotStore } from "./CommandProcessSlotStore.ts";
import {
  ChildWorkerAdmissionQueue,
  type InternalChildWorkerPermit,
} from "./childWorkerCapacity/AdmissionQueue.ts";
import {
  ProcessSlotChildWorkerPermit,
  type ChildWorkerPermitHooks,
} from "./childWorkerCapacity/Execution.ts";
import { issueChildWorkerReservation } from "./childWorkerCapacity/Reservation.ts";
import type {
  ChildWorkerExecution,
  ChildWorkerPermit,
  ChildWorkerPressureListener,
  ChildWorkerRequester,
  ChildWorkerReservation,
  ChildWorkerSlotRequest,
} from "./childWorkerCapacity/types.ts";

export type {
  ChildWorkerExecution,
  ChildWorkerPermit,
  ChildWorkerRequester,
  ChildWorkerReservation,
  ChildWorkerSlotRequest,
} from "./childWorkerCapacity/types.ts";
export { isChildWorkerReservation } from "./childWorkerCapacity/Reservation.ts";

// Bash packs under 64 MiB; this leaves growth room before a syscall checkpoint and 24 MiB for the runtime.
const DEFAULT_RESIDENT_BYTE_LIMIT = 104 * 1024 * 1024;
const DEFAULT_PRESSURE_QUANTUM_MS = 100;
const LEGACY_REQUEST: ChildWorkerSlotRequest = Object.freeze({
  codeId: "legacy",
  residentBytes: 0,
});

export interface ChildWorkerCapacityOptions {
  /** Required with externally supplied slots. Otherwise a unique lifetime-only namespace is made. */
  readonly owner?: string;
  /** Its inFlightLimit must equal `limit`; this adapter must be its sole acquire caller. */
  readonly slots?: ProcessSlots | Promise<ProcessSlots>;
  readonly store?: ProcessSlotStore;
  readonly residentByteLimit?: number;
  readonly scheduleQuantum?: ProcessSlotsOptions["scheduleQuantum"];
}

/** Construct once per DO. The adapter never raises the supplied in-flight limit for descendants. */
export class ChildWorkerCapacity {
  readonly limit: number;
  readonly owner: string;
  readonly residentByteLimit: number;
  readonly #slots: Promise<ProcessSlots>;
  #slotSignals: ProcessSlots["signals"] | undefined;
  readonly #scheduleQuantum: ProcessSlotsOptions["scheduleQuantum"];
  readonly #admissions: ChildWorkerAdmissionQueue;
  readonly #owners = new WeakSet<object>();
  readonly #pressureListeners = new Set<ChildWorkerPressureListener>();
  #failure: { readonly error: unknown } | undefined;

  constructor(limit: number, options: ChildWorkerCapacityOptions = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Child worker capacity must be a positive safe integer");
    }
    const residentByteLimit = options.residentByteLimit ?? DEFAULT_RESIDENT_BYTE_LIMIT;
    if (!Number.isSafeInteger(residentByteLimit) || residentByteLimit < 1) {
      throw new RangeError("Child worker resident byte limit must be a positive safe integer");
    }
    this.limit = limit;
    this.residentByteLimit = residentByteLimit;
    this.#scheduleQuantum = options.scheduleQuantum ?? scheduleQuantum;
    if (options.slots !== undefined) {
      if (options.owner === undefined) {
        throw new TypeError("An owner namespace is required with supplied ProcessSlots");
      }
      validateOwner(options.owner);
      this.owner = options.owner;
      this.#slots = Promise.resolve(options.slots);
    } else {
      this.owner = options.owner ?? ephemeralOwner();
      validateOwner(this.owner);
      this.#slots = createProcessSlots({
        owner: this.owner,
        inFlightLimit: limit,
        residentByteLimit,
        store: options.store ?? new CommandProcessSlotStore(),
        scheduleQuantum: this.#scheduleQuantum,
        // Each generation has a distinct loader ID; this per-DO adapter keeps no stub cache.
        invalidate: () => {},
        reconcile: async () => ({ lost: "isolate" }),
      });
    }
    this.#admissions = new ChildWorkerAdmissionQueue({
      limit,
      owner: this.owner,
      residentByteLimit,
      slots: this.#slots,
      scheduleQuantum: this.#scheduleQuantum,
      onCapacityPressure: (adapterWaiters) => this.#notifyCapacityPressure(adapterWaiters),
      isNested: (requester) => this.#isNested(requester),
      makePermit: (slots, lease, permit, hooks, byteLimit) =>
        this.#makePermit(slots, lease, permit, hooks, byteLimit),
    });
    void this.#slots.then(
      (slots) => {
        this.#slotSignals = slots.signals;
        slots.signals.onFenced((error) => this.#fence(error));
        slots.signals.onPressure((pressure) => this.#admissions.handlePressure(pressure));
        slots.signals.onPressure((pressure) => this.#notifyPressure(pressure));
      },
      (error: unknown) => this.#fence(error),
    );
  }

  get active(): number {
    return this.#admissions.active;
  }

  get waiting(): number {
    return this.#admissions.waiting;
  }

  get failure(): unknown {
    return this.#failure?.error;
  }

  onPressure(listener: ChildWorkerPressureListener): () => void {
    this.#pressureListeners.add(listener);
    return () => this.#pressureListeners.delete(listener);
  }

  #notifyPressure(pressure: ProcessSlotPressure): void {
    for (const listener of this.#pressureListeners) {
      try {
        listener(pressure);
      } catch {
        // A supervisor observer cannot wedge child admission.
      }
    }
  }

  #notifyCapacityPressure(adapterWaiters: number): void {
    const signals = this.#slotSignals;
    if (signals === undefined) return;
    this.#notifyPressure({
      kind: "capacity",
      inFlight: signals.inFlight,
      resident: signals.resident,
      waiting: Math.max(adapterWaiters, signals.waiting),
    });
  }

  acquire(
    signal: AbortSignal,
    requester: ChildWorkerRequester | undefined,
    code: ChildWorkerSlotRequest = LEGACY_REQUEST,
  ): Promise<ChildWorkerPermit> {
    return this.#acquire(signal, requester, code);
  }

  async reserve(
    signal: AbortSignal,
    requester: ChildWorkerRequester,
    code: ChildWorkerSlotRequest,
  ): Promise<ChildWorkerReservation> {
    const permit = await this.#acquire(signal, requester, code);
    return issueChildWorkerReservation(permit, code, (error) => this.#fence(error));
  }

  async run<T>(
    signal: AbortSignal,
    work: (execution: ChildWorkerExecution) => Promise<T>,
    requester: ChildWorkerRequester,
    code: ChildWorkerSlotRequest,
  ): Promise<T> {
    const permit = (await this.#acquire(signal, requester, code)) as InternalChildWorkerPermit;
    try {
      signal.throwIfAborted();
      permit.bind(requester);
      return await work(permit.execution);
    } finally {
      await permit.release();
    }
  }

  #acquire(
    signal: AbortSignal,
    requester: ChildWorkerRequester | undefined,
    code: ChildWorkerSlotRequest,
  ): Promise<InternalChildWorkerPermit> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#failure !== undefined) return Promise.reject(this.#failure.error);
    if (!Object.isFrozen(code)) {
      return Promise.reject(new TypeError("Child worker slot request must be immutable"));
    }
    validateCodeId(code.codeId);
    if (!Number.isSafeInteger(code.residentBytes) || code.residentBytes < 0) {
      return Promise.reject(new RangeError("Invalid child worker resident byte count"));
    }
    return this.#admissions.acquire(signal, requester, code);
  }

  #isNested(requester: ChildWorkerRequester | undefined): boolean {
    const owner = requester?.processes.admissionOwner(requester.process);
    return owner?.status === "ok" && owner.value !== undefined && this.#owners.has(owner.value);
  }

  #makePermit(
    slots: ProcessSlots,
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    hooks: Omit<ChildWorkerPermitHooks, "bind">,
    residentByteLimit: number,
  ): InternalChildWorkerPermit {
    let owner: object | undefined;
    let bound = false;
    return new ProcessSlotChildWorkerPermit(
      slots,
      lease,
      permit,
      {
        bind: (requester) => {
          if (bound) throw new Error("Child worker permit was already bound");
          if (requester.process === undefined) {
            throw new Error("Child worker requester process is unavailable");
          }
          const token = Object.freeze({});
          const assigned = requester.processes.setAdmissionOwner(requester.process, token);
          if (assigned.status !== "ok") {
            throw new Error("Child worker requester process is unavailable");
          }
          bound = true;
          owner = token;
          this.#owners.add(token);
        },
        ending: () => {
          if (owner !== undefined) this.#owners.delete(owner);
          owner = undefined;
          hooks.ending();
        },
        ended: hooks.ended,
        failed: hooks.failed,
      },
      residentByteLimit,
    );
  }

  #fence(error: unknown): void {
    if (this.#failure !== undefined) return;
    this.#failure = { error };
    this.#admissions.fence(error);
  }
}

function validSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\s/\\]/u.test(value) &&
    [...value].every((character) => character.charCodeAt(0) >= 32)
  );
}

function validateCodeId(value: string): void {
  if (!validSegment(value)) {
    throw new TypeError("Code ID must be one nonempty namespace segment");
  }
}

function validateOwner(value: string): void {
  const parts = value.split("/");
  if (parts.length < 2 || !parts.every(validSegment)) {
    throw new TypeError("Process-slot owner must include supervisor and shard");
  }
}

function ephemeralOwner(): string {
  return `command-${crypto.randomUUID()}/capacity-${crypto.randomUUID()}`;
}

const scheduleQuantum: ProcessSlotsOptions["scheduleQuantum"] = (callback) => {
  // Capacity pressure is a supervisor hint; a bounded 100 ms tick avoids a busy retry loop.
  const timer = setTimeout(callback, DEFAULT_PRESSURE_QUANTUM_MS);
  return () => clearTimeout(timer);
};
