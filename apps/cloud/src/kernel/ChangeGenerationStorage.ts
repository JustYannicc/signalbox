import type { Storage } from "./storage.ts";

/**
 * Storage that can say cheaply whether anything may have changed. The value never decreases;
 * equal values mean no mutation committed in between, and a larger one says nothing about what.
 */
export interface ChangeGenerationStorage extends Storage {
  changeGeneration(): number;
}

export function hasChangeGeneration(storage: unknown): storage is ChangeGenerationStorage {
  return (
    typeof storage === "object" &&
    storage !== null &&
    "changeGeneration" in storage &&
    typeof storage.changeGeneration === "function"
  );
}
