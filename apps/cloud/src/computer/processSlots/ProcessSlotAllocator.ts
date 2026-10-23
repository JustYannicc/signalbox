// @effect-diagnostics cryptoRandomUUID:off - each durable holder needs a token unique across allocator recovery.
import type {
  ProcessSlotLease,
  ProcessSlotLeaseToken,
  ProcessSlotPermit,
  ProcessSlotRequest,
  ProcessSlotSignals,
  ProcessSlotState,
  ProcessSlots,
  ProcessSlotsOptions,
} from "./ProcessSlotTypes.ts";
import { ProcessSlotJournal } from "./ProcessSlotJournal.ts";
import { ProcessSlotQueue } from "./ProcessSlotQueue.ts";
import {
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
  readonly #listeners = new Set<Parameters<ProcessSlotSignals["onPressure"]>[0]>();
  readonly #parks = new Map<ProcessSlotLeaseToken, AbortController>();
  readonly #inFlightLimit: number;
  readonly journal: ProcessSlotJournal;
  readonly options: ProcessSlotsOptions;

  constructor(journal: ProcessSlotJournal, options: ProcessSlotsOptions) {
    this.journal = journal;
    this.options = options;
    this.#inFlightLimit = options.ioContext === "durable-object" ? 10 : 4;
    this.#queue = new ProcessSlotQueue(options.scheduleQuantum, () => {
      const state = { ...counts(journal.state), waiting: this.#queue.waiting };
      for (const listener of this.#listeners) listener(state);
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
      onPressure(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  }

  async recover(): Promise<void> {
    for (const slot of this.journal.state.slots) {
      if (slot.invalidating !== undefined) await this.#invalidate(slot);
      if (slot.holder === undefined) continue;
      const lease = leaseFor(this.options.owner, slot);
      const result = await this.options.reconcile(lease);
      if ("lost" in result) await this.lose(lease, result.lost);
      else await this.release(lease, result);
    }
  }

  async acquire(request: ProcessSlotRequest) {
    const { owner, codeId: code, residentBytes, signal } = request;
    signal.throwIfAborted();
    if (owner !== this.options.owner) throw new TypeError("Process-slot request owner mismatch");
    codeId(code);
    bytes(residentBytes);
    return await this.#queue.enqueue(
      signal,
      () => {
        this.journal.check();
        return this.#hasRoom(residentBytes);
      },
      async () => {
        const state = this.journal.state;
        const matching = state.slots.filter((slot) => slot.codeId === code);
        const free = matching
          .filter((slot) => slot.holder === undefined && slot.invalidating === undefined)
          .sort((a, b) => a.index - b.index)[0];
        const index =
          free?.index ?? matching.reduce((next, slot) => Math.max(next, slot.index + 1), 0);
        bytes(index);
        const slot: Slot = {
          codeId: code,
          index,
          generation: free?.generation ?? 0,
          holder: {
            token: crypto.randomUUID() as ProcessSlotLeaseToken,
            residentBytes,
            permitted: true,
          },
        };
        const next =
          free === undefined
            ? { ...state, slots: [...state.slots, slot] }
            : replaceSlot(state, free, slot);
        await this.journal.commit(next, signal);
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
      this.journal.check();
      const slot = requireHolder(this.journal.state, lease);
      if (permit.token !== lease.token || !slot.holder?.permitted) {
        throw new Error("Stale process-slot permit");
      }
      await this.journal.commit(
        replaceSlot(this.journal.state, slot, {
          ...slot,
          holder: { ...slot.holder, permitted: false },
        }),
        signal,
      );
      this.#parks.set(lease.token, cancelled);
    });
    this.#queue.wake();
    try {
      const result = await waitWhileParked(waitFor, parkedSignal).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const resumed = await this.#queue.enqueue(
        parkedSignal,
        () => {
          this.journal.check();
          const slot = requireHolder(this.journal.state, lease);
          if (slot.holder === undefined) throw new Error("Stale process-slot lease");
          return this.#hasRoom(slot.holder.residentBytes);
        },
        async () => {
          const slot = requireHolder(this.journal.state, lease);
          if (slot.holder === undefined) throw new Error("Stale process-slot lease");
          await this.journal.commit(
            replaceSlot(this.journal.state, slot, {
              ...slot,
              holder: { ...slot.holder, permitted: true },
            }),
            parkedSignal,
          );
          return permit;
        },
      );
      if (!result.ok) throw result.error;
      return { value: result.value, permit: resumed };
    } finally {
      this.#parks.delete(lease.token);
    }
  }

  observe(lease: ProcessSlotLease, residentBytes: number): void {
    if (findHolder(this.journal.state, lease) === undefined) return;
    bytes(residentBytes);
    // The void interface cannot report an async save error. Fence every subsequent operation on it.
    void this.#queue
      .serial(async () => {
        this.journal.check();
        const slot = findHolder(this.journal.state, lease);
        if (slot?.holder === undefined) return;
        await this.journal.commit(
          replaceSlot(this.journal.state, slot, {
            ...slot,
            holder: { ...slot.holder, residentBytes },
          }),
        );
      })
      .catch((error: unknown) => {
        this.journal.fail(error);
      })
      .finally(() => this.#queue.wake());
  }

  async release(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void> {
    if (stopped.acknowledged !== true) throw new TypeError("Process-slot stop is not acknowledged");
    await this.#retire(lease, false);
  }

  async handoff(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void> {
    await this.release(lease, stopped);
  }

  async lose(lease: ProcessSlotLease, reason: "memory" | "isolate"): Promise<void> {
    if (reason !== "memory" && reason !== "isolate")
      throw new TypeError("Unknown process-slot loss");
    await this.#retire(lease, true);
  }

  async #retire(lease: ProcessSlotLease, lost: boolean): Promise<void> {
    try {
      await this.#queue.serial(async () => {
        this.journal.check();
        const state = this.journal.state;
        const slot = requireHolder(state, lease);
        const generation = slot.generation + Number(lost);
        bytes(generation);
        const next: ProcessSlotState = {
          ...replaceSlot(state, slot, {
            codeId: slot.codeId,
            index: slot.index,
            generation,
            ...(lost ? { invalidating: slot.generation } : {}),
          }),
          lost: state.lost + Number(lost),
        };
        try {
          await this.journal.commit(next);
        } catch (error) {
          // A known lost isolate must never become a warm slot after an unrelated normal release.
          if (lost) this.journal.fail(error);
          throw error;
        }
        this.#parks.get(lease.token)?.abort(new Error("Stale process-slot lease"));
        if (lost) {
          const retired = this.journal.state.slots.find(
            (entry) => entry.codeId === slot.codeId && entry.index === slot.index,
          )!;
          try {
            await this.#invalidate(retired);
          } catch (error) {
            this.journal.fail(error);
            throw error;
          }
        }
      });
    } finally {
      this.#queue.wake();
    }
  }

  #hasRoom(residentBytes: number): boolean {
    return (
      residentBytes <= this.options.residentByteLimit &&
      counts(this.journal.state).inFlight < this.#inFlightLimit
    );
  }

  async #invalidate(slot: Slot): Promise<void> {
    await this.options.invalidate(
      `${this.options.owner}/${slot.codeId}/${slot.index}.${slot.invalidating}`,
    );
    await this.journal.commit(
      replaceSlot(this.journal.state, slot, {
        codeId: slot.codeId,
        index: slot.index,
        generation: slot.generation,
      }),
    );
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
