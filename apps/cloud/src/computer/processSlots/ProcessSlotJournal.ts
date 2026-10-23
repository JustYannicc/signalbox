import type { ProcessSlotState, ProcessSlotStore } from "./ProcessSlotTypes.ts";
import { validateState } from "./ProcessSlotState.ts";

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
  #fault: unknown;
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

  check(): void {
    if (this.#fault !== undefined) throw this.#fault;
  }

  fail(error: unknown): void {
    this.#fault = error;
  }

  async commit(next: ProcessSlotState, signal?: AbortSignal): Promise<void> {
    this.check();
    signal?.throwIfAborted();
    await this.#save(next);
    if (signal?.aborted) {
      try {
        await this.#save(this.#state);
      } catch (error) {
        // A failed rollback leaves a durable holder that recovery must reconcile.
        this.#state = next;
        this.fail(error);
        throw error;
      }
      signal.throwIfAborted();
    }
    this.#state = next;
  }

  async #save(state: ProcessSlotState) {
    try {
      await this.#store.save(structuredClone(state));
    } catch (cause) {
      throw new ProcessSlotStorageError("save", cause);
    }
  }
}
