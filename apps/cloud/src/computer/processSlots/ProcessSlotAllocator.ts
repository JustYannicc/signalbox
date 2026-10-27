// @effect-diagnostics cryptoRandomUUID:off - each durable holder needs a token unique across allocator recovery.
import type {
  ProcessSlotBlocker,
  ProcessSlotLease,
  ProcessSlotLeaseToken,
  ProcessSlotPermit,
  ProcessSlotPressure,
  ProcessSlotRequest,
  ProcessSlotSignals,
  ProcessSlots,
  ProcessSlotsOptions,
} from "./ProcessSlotTypes.ts";
import { ProcessSlotJournal } from "./ProcessSlotJournal.ts";
import { ProcessSlotLifecycle } from "./ProcessSlotLifecycle.ts";
import { ProcessSlotListeners } from "./ProcessSlotListeners.ts";
import { ProcessSlotQueue } from "./ProcessSlotQueue.ts";
import {
  availableSlot,
  bytes,
  codeId,
  counts,
  findHolder,
  leaseFor,
  replaceSlot,
  requireHolder,
  type Slot,
} from "./ProcessSlotState.ts";

export class ProcessSlotAllocator implements ProcessSlots {
  readonly signals: ProcessSlotSignals;
  readonly #queue: ProcessSlotQueue;
  readonly #listeners = new ProcessSlotListeners<ProcessSlotPressure>();
  readonly #parks = new Map<ProcessSlotLeaseToken, AbortController>();
  readonly #journal: ProcessSlotJournal;
  readonly #options: ProcessSlotsOptions;
  readonly #lifecycle: ProcessSlotLifecycle;

  constructor(journal: ProcessSlotJournal, options: ProcessSlotsOptions) {
    this.#journal = journal;
    this.#options = options;
    this.#queue = new ProcessSlotQueue(options.scheduleQuantum, (blocker) => {
      this.#listeners.emit({ ...counts(journal.state), waiting: this.#queue.waiting, ...blocker });
    });
    this.#lifecycle = new ProcessSlotLifecycle(journal, this.#queue, options, (lease) => {
      this.#parks.get(lease.token)?.abort(new Error("Stale process-slot lease"));
    });
    const queue = this.#queue;
    const listeners = this.#listeners;
    this.signals = Object.freeze<ProcessSlotSignals>({
      get inFlight() {
        return counts(journal.state).inFlight;
      },
      get resident() {
        return counts(journal.state).resident;
      },
      get waiting() {
        return queue.waiting;
      },
      get lost() {
        return journal.state.lost;
      },
      get fenced() {
        return journal.fenced;
      },
      onFenced: (listener) => journal.onFenced(listener),
      onPressure: (listener) => listeners.subscribe(listener),
    });
  }

  get inFlightLimit(): number {
    return this.#options.inFlightLimit;
  }

  async recover(): Promise<void> {
    await this.#lifecycle.recover();
  }

  async acquire(request: ProcessSlotRequest) {
    const captured = Object.freeze({ ...request });
    const { owner, codeId: code, residentBytes, signal } = captured;
    signal.throwIfAborted();
    if (owner !== this.#options.owner) throw new TypeError("Process-slot request owner mismatch");
    codeId(code);
    bytes(residentBytes);
    return await this.#queue.enqueue(
      signal,
      () => this.#admission(residentBytes, { kind: "unplaceable", request: captured }),
      async () => {
        const state = this.#journal.state;
        const free = availableSlot(state, code);
        const slot: Slot = {
          ...free,
          holder: {
            token: crypto.randomUUID() as ProcessSlotLeaseToken,
            residentBytes,
            permitted: true,
          },
        };
        const next = state.slots.includes(free)
          ? replaceSlot(state, free, slot)
          : { ...state, slots: [...state.slots, slot] };
        await this.#journal.commit(next, signal);
        const lease = leaseFor(owner, slot);
        return { lease, permit: Object.freeze({ token: lease.token }) };
      },
    );
  }

  async park<T>(
    lease: ProcessSlotLease,
    permit: ProcessSlotPermit,
    waitFor: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<{ value: T; permit: ProcessSlotPermit }> {
    const cancelled = new AbortController();
    const parkedSignal = AbortSignal.any([signal, cancelled.signal]);
    await this.#queue.serial(async () => {
      this.#journal.check();
      const slot = requireHolder(this.#journal.state, lease);
      if (permit.token !== lease.token || !slot.holder?.permitted)
        throw new Error("Stale process-slot permit");
      await this.#journal.commit(
        replaceSlot(this.#journal.state, slot, {
          ...slot,
          holder: { ...slot.holder, permitted: false },
        }),
        signal,
      );
      this.#parks.set(lease.token, cancelled);
    });
    this.#queue.wake();
    try {
      const value = await waitWhileParked(waitFor, parkedSignal);
      const resumed = await this.#queue.enqueue(
        parkedSignal,
        () => {
          const slot = requireHolder(this.#journal.state, lease);
          if (slot.holder === undefined) throw new Error("Stale process-slot lease");
          const residentBytes = this.#journal.residentBytes(slot.holder);
          return this.#admission(residentBytes, {
            kind: "unplaceable",
            lease: { ...lease, residentBytes },
          });
        },
        async () => {
          const slot = requireHolder(this.#journal.state, lease);
          if (slot.holder === undefined) throw new Error("Stale process-slot lease");
          await this.#journal.commit(
            replaceSlot(this.#journal.state, slot, {
              ...slot,
              holder: { ...slot.holder, permitted: true },
            }),
            parkedSignal,
          );
          return permit;
        },
      );
      return { value, permit: resumed };
    } finally {
      this.#parks.delete(lease.token);
    }
  }

  observe(lease: ProcessSlotLease, residentBytes: number): void {
    const slot = findHolder(this.#journal.state, lease);
    if (slot?.holder === undefined) return;
    bytes(residentBytes);
    const previous = this.#journal.residentBytes(slot.holder);
    this.#journal.observe(lease.token, residentBytes);
    if (
      previous <= this.#options.residentByteLimit !==
      residentBytes <= this.#options.residentByteLimit
    )
      this.#queue.wake();
  }

  async release(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void> {
    await this.#lifecycle.release(lease, stopped);
  }

  async handoff(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void> {
    await this.#lifecycle.release(lease, stopped);
  }

  async lose(lease: ProcessSlotLease, reason: "memory" | "isolate"): Promise<void> {
    await this.#lifecycle.lose(lease, reason);
  }

  #admission(residentBytes: number, unplaceable: ProcessSlotBlocker): "ready" | ProcessSlotBlocker {
    this.#journal.check();
    if (residentBytes > this.#options.residentByteLimit) return unplaceable;
    return counts(this.#journal.state).inFlight < this.#options.inFlightLimit
      ? "ready"
      : { kind: "capacity" };
  }
}

function waitWhileParked<T>(waitFor: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let waiting: Promise<T>;
    try {
      waiting = waitFor();
    } catch (error) {
      waiting = Promise.reject(error);
    }
    void waiting.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
