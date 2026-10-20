import type { Storage } from "./storage.ts";

/**
 * Storage that can say cheaply whether anything may have changed. The value never decreases;
 * equal values mean no mutation committed in between, and a larger one says nothing about what.
 */
export interface ChangeGenerationStorage {
  changeGeneration(): number;
}

export function readChangeGeneration(storage: Storage): number | undefined {
  if (!("changeGeneration" in storage) || typeof storage.changeGeneration !== "function") {
    return undefined;
  }
  const generation: unknown = storage.changeGeneration();
  return typeof generation === "number" ? generation : undefined;
}
