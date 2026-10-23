import type { ProcessSlotState, ProcessSlotStore } from "../../ProcessSlots.ts";

export class InMemoryProcessSlotStore implements ProcessSlotStore {
  #state: ProcessSlotState | undefined;
  failure: Error | undefined;
  beforeSave: ((state: ProcessSlotState) => Promise<void>) | undefined;

  constructor(state?: ProcessSlotState) {
    this.#state = structuredClone(state);
  }

  async load() {
    return structuredClone(this.#state);
  }

  async save(state: ProcessSlotState) {
    await this.beforeSave?.(structuredClone(state));
    if (this.failure !== undefined) throw this.failure;
    this.#state = structuredClone(state);
  }
}
