import type { ProcessSlotState, ProcessSlotStore } from "./ProcessSlots.ts";

/** Interim command-gateway owner until the supervisor supplies its durable store in #1396. */
export class CommandProcessSlotStore implements ProcessSlotStore {
  #state: ProcessSlotState | undefined;

  async load(): Promise<ProcessSlotState | undefined> {
    return this.#state === undefined ? undefined : structuredClone(this.#state);
  }

  async save(state: ProcessSlotState): Promise<void> {
    this.#state = structuredClone(state);
  }
}
