import type { ProcessSlotState, ProcessSlotStore } from "../ProcessSlots.ts";

/** In-memory store for callers whose capacity lifetime is shorter than one request. */
export class CommandProcessSlotStore implements ProcessSlotStore {
  #state: ProcessSlotState | undefined;

  async load(): Promise<ProcessSlotState | undefined> {
    return this.#state === undefined ? undefined : structuredClone(this.#state);
  }

  async save(state: ProcessSlotState): Promise<void> {
    this.#state = structuredClone(state);
  }
}
