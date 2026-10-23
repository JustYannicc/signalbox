import type { ProcessSlotState, ProcessSlotStore } from "../ProcessSlots.ts";

export interface DurableProcessSlotStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

const STORAGE_KEY_PREFIX = "child-worker-slots-v1";

/** A single atomic storage value keeps slot generations across Durable Object wakes. */
export class DurableProcessSlotStore implements ProcessSlotStore {
  readonly #storage: DurableProcessSlotStorage;
  readonly #key: string;

  constructor(storage: DurableProcessSlotStorage, owner: string) {
    this.#storage = storage;
    this.#key = `${STORAGE_KEY_PREFIX}:${owner}`;
  }

  async load(): Promise<ProcessSlotState | undefined> {
    const state = await this.#storage.get<ProcessSlotState>(this.#key);
    return state === undefined ? undefined : structuredClone(state);
  }

  async save(state: ProcessSlotState): Promise<void> {
    await this.#storage.put(this.#key, structuredClone(state));
  }
}
