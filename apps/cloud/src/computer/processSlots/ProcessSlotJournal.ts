import type {
  ProcessSlotLeaseToken,
  ProcessSlotState,
  ProcessSlotStore,
} from "./ProcessSlotTypes.ts";
import { validateState } from "./ProcessSlotState.ts";
import { ProcessSlotListeners } from "./ProcessSlotListeners.ts";

export class ProcessSlotStorageError extends Error {
  override readonly name = "ProcessSlotStorageError";
  readonly operation: "load" | "save";
  constructor(operation: "load" | "save", cause: unknown) {
    super(`Process-slot storage ${operation} failed`, { cause });
    this.operation = operation;
  }
}

export class ProcessSlotJournal {
  #state: ProcessSlotState;
  #fault: { error: unknown } | undefined;
  readonly #measurements = new Map<ProcessSlotLeaseToken, number>();
  readonly #fenced = new ProcessSlotListeners<unknown>();
  readonly #store: ProcessSlotStore;

  private constructor(store: ProcessSlotStore, state: ProcessSlotState) {
    this.#store = store;
    this.#state = structuredClone(state);
  }

  static async open(store: ProcessSlotStore, owner: string) {
    let state: ProcessSlotState | undefined;
    try {
      state = await store.load();
    } catch (cause) {
      throw new ProcessSlotStorageError("load", cause);
    }
    if (state !== undefined) validateState(state, owner);
    return new ProcessSlotJournal(store, state ?? { version: 1, owner, lost: 0, slots: [] });
  }

  get state() {
    return this.#state;
  }

  get fenced() {
    return this.#fault !== undefined;
  }

  onFenced(listener: (error: unknown) => void): () => void {
    const unsubscribe = this.#fenced.subscribe(listener);
    if (this.#fault !== undefined) {
      try {
        listener(this.#fault.error);
      } catch {
        // A late observer has the same failure isolation as an already subscribed observer.
      }
    }
    return unsubscribe;
  }

  observe(token: ProcessSlotLeaseToken, residentBytes: number): void {
    this.#measurements.set(token, residentBytes);
  }

  residentBytes(holder: NonNullable<ProcessSlotState["slots"][number]["holder"]>): number {
    return this.#measurements.get(holder.token) ?? holder.residentBytes;
  }

  check(): void {
    if (this.#fault !== undefined) throw this.#fault.error;
  }

  fail(error: unknown): void {
    if (this.#fault !== undefined) return;
    this.#fault = { error };
    this.#fenced.emit(error);
  }

  async commit(next: ProcessSlotState, signal?: AbortSignal): Promise<void> {
    this.check();
    signal?.throwIfAborted();
    const written = this.#snapshot(next);
    await this.#save(written);
    if (signal?.aborted) {
      try {
        await this.#save(this.#snapshot(this.#state));
      } catch (error) {
        // A failed rollback leaves a durable holder that recovery must reconcile.
        this.#state = written;
        this.fail(error);
        throw error;
      }
      signal.throwIfAborted();
    }
    this.#state = written;
    const live = new Set(
      written.slots.flatMap((slot) => (slot.holder === undefined ? [] : [slot.holder.token])),
    );
    for (const token of this.#measurements.keys())
      if (!live.has(token)) this.#measurements.delete(token);
  }

  #snapshot(state: ProcessSlotState): ProcessSlotState {
    return {
      ...state,
      slots: state.slots
        .filter(
          (slot) =>
            slot.generation > 0 || slot.holder !== undefined || slot.invalidating !== undefined,
        )
        .map((slot) =>
          slot.holder === undefined
            ? slot
            : {
                ...slot,
                holder: { ...slot.holder, residentBytes: this.residentBytes(slot.holder) },
              },
        ),
    };
  }

  async #save(state: ProcessSlotState) {
    try {
      await this.#store.save(structuredClone(state));
    } catch (cause) {
      throw new ProcessSlotStorageError("save", cause);
    }
  }
}
