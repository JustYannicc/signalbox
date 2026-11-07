import type { KernelLowerFileSystemUpperStorage } from "./KernelLowerFileSystemUpperStorage.ts";
import type { PosixStorage } from "./PosixStorage.ts";
import type { Storage } from "./storage.ts";

/**
 * The read half of upper storage at one instant, from a few bulk reads. Reading a tree through
 * live `lookup` and `stat` costs queries per path component; a snapshot costs them once per tree.
 * Reads answer as live storage did at that instant, and every write fails with EROFS.
 */
export type KernelStorageSnapshot = PosixStorage &
  KernelLowerFileSystemUpperStorage & {
    /** Nothing it answers changes, so a name it lacks stays missing. */
    readonly immutable: true;
  };

export interface SnapshotStorage extends Storage {
  /** Fails with E2BIG past `maxEntries` names, so a tree too large to hold is never read whole. */
  snapshot(maxEntries: number): KernelStorageSnapshot;
}

export function hasStorageSnapshot(storage: unknown): storage is SnapshotStorage {
  return (
    typeof storage === "object" &&
    storage !== null &&
    "snapshot" in storage &&
    typeof storage.snapshot === "function"
  );
}

export function isStorageSnapshot(storage: unknown): storage is KernelStorageSnapshot {
  return (
    typeof storage === "object" &&
    storage !== null &&
    "immutable" in storage &&
    storage.immutable === true
  );
}
