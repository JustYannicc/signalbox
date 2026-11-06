import type { Storage } from "./storage.ts";

/**
 * Storage that can say cheaply whether anything may have changed. The value never decreases;
 * equal values mean no mutation committed in between, and a larger one says nothing about what.
 */
export interface FileChanges {
  readonly inodes: readonly bigint[];
  readonly names: readonly { readonly parent: bigint; readonly name: string }[];
}

export interface ChangeGenerationStorage extends Storage {
  changeGeneration(): number;
  /**
   * Changed after `since`: inodes, and directory names whose entry changed (a copy-up gives an
   * existing name a new inode). Undefined when this incarnation can't say.
   */
  changesSince?(since: number): FileChanges | undefined;
}

export function hasChangeGeneration(storage: unknown): storage is ChangeGenerationStorage {
  return (
    typeof storage === "object" &&
    storage !== null &&
    "changeGeneration" in storage &&
    typeof storage.changeGeneration === "function"
  );
}
