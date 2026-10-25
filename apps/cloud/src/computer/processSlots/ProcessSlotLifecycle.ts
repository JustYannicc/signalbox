import type { ProcessSlotLease, ProcessSlotsOptions } from "./ProcessSlotTypes.ts";
import { ProcessSlotJournal } from "./ProcessSlotJournal.ts";
import { ProcessSlotQueue } from "./ProcessSlotQueue.ts";
import {
  bytes,
  leaseFor,
  loaderId,
  replaceSlot,
  requireHolder,
  type Slot,
} from "./ProcessSlotState.ts";

export class ProcessSlotLifecycle {
  readonly #journal: ProcessSlotJournal;
  readonly #queue: ProcessSlotQueue;
  readonly #options: ProcessSlotsOptions;
  readonly #retired: (lease: ProcessSlotLease) => void;

  constructor(
    journal: ProcessSlotJournal,
    queue: ProcessSlotQueue,
    options: ProcessSlotsOptions,
    retired: (lease: ProcessSlotLease) => void,
  ) {
    this.#journal = journal;
    this.#queue = queue;
    this.#options = options;
    this.#retired = retired;
  }

  async recover(): Promise<void> {
    const pending = this.#journal.state.slots.values();
    let failure: { error: unknown } | undefined;
    const recover = async () => {
      while (failure === undefined) {
        const slot = pending.next().value;
        if (slot === undefined) return;
        try {
          if (slot.invalidating !== undefined) {
            await this.#queue.serial(() => this.#invalidate(slot));
          } else if (slot.holder !== undefined) {
            const lease = leaseFor(this.#options.owner, slot);
            const result =
              slot.holder.lost === undefined
                ? await this.#options.reconcile(lease)
                : { lost: slot.holder.lost };
            if ("lost" in result) await this.lose(lease, result.lost);
            else await this.release(lease, result);
          }
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    const concurrency = Math.min(
      this.#options.recoveryConcurrency ?? 4,
      this.#journal.state.slots.length,
    );
    // Finish every started probe before rejecting factory creation; none can mutate storage afterward.
    await Promise.all(Array.from({ length: concurrency }, recover));
    if (failure !== undefined) throw failure.error;
  }

  async release(lease: ProcessSlotLease, stopped: { readonly acknowledged: true }): Promise<void> {
    if (stopped.acknowledged !== true) throw new TypeError("Process-slot stop is not acknowledged");
    await this.#retire(lease);
  }

  async lose(lease: ProcessSlotLease, reason: "memory" | "isolate"): Promise<void> {
    if (reason !== "memory" && reason !== "isolate")
      throw new TypeError("Unknown process-slot loss");
    await this.#retire(lease, reason);
  }

  async #retire(lease: ProcessSlotLease, lost?: "memory" | "isolate"): Promise<void> {
    try {
      await this.#queue.serial(async () => {
        this.#journal.check();
        requireHolder(this.#journal.state, lease);
        try {
          if (lost !== undefined) {
            const slot = requireHolder(this.#journal.state, lease);
            if (slot.holder !== undefined && slot.holder.lost === undefined) {
              await this.#journal.commit(
                replaceSlot(this.#journal.state, slot, {
                  ...slot,
                  holder: { ...slot.holder, lost },
                }),
              );
            }
          }
          const state = this.#journal.state;
          const slot = requireHolder(state, lease);
          const generation = slot.generation + Number(lost !== undefined);
          bytes(generation);
          const retired: Slot = {
            codeId: slot.codeId,
            index: slot.index,
            generation,
            ...(lost === undefined ? {} : { invalidating: slot.generation }),
          };
          await this.#journal.commit({
            ...replaceSlot(state, slot, retired),
            lost: state.lost + Number(lost !== undefined),
          });
          this.#retired(lease);
          if (lost !== undefined) await this.#invalidate(retired);
        } catch (error) {
          // Failure before the first loss marker can only be remembered by this session and its supervisor.
          if (lost !== undefined) this.#journal.fail(error);
          throw error;
        }
      });
    } finally {
      this.#queue.wake();
    }
  }

  async #invalidate(slot: Slot): Promise<void> {
    await this.#options.invalidate(
      loaderId(this.#options.owner, { ...slot, generation: slot.invalidating! }),
    );
    const state = this.#journal.state;
    const current = state.slots.find(
      (entry) => entry.codeId === slot.codeId && entry.index === slot.index,
    )!;
    await this.#journal.commit(
      replaceSlot(state, current, {
        codeId: current.codeId,
        index: current.index,
        generation: current.generation,
      }),
    );
  }
}
