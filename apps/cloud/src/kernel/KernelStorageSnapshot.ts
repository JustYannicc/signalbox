import type { PosixMetadata } from "./PosixStorage.ts";
import type { DirectoryEntry, Inode, Stat, Storage } from "./storage.ts";

/**
 * A storage's names and inodes at one instant, from a few bulk reads. Indexing a tree through
 * `lookup` and `stat` costs queries per path component; a snapshot costs them once per tree.
 * Each method answers as its live counterpart would at the instant the snapshot was read.
 */
export interface KernelStorageSnapshot {
  /** As `readdir` lists them, in its order. */
  children(directory: Inode): readonly DirectoryEntry[];
  /** As `lookup` finds it; undefined where it fails with ENOENT. */
  lookup(directory: Inode, name: string): Inode | undefined;
  /** As `stat` reports it; undefined for an inode no name reaches, which only a live call knows. */
  stat(inode: Inode): Stat | undefined;
  readlink(inode: Inode): string;
  /** As `posix.get` reports it; undefined where that fails with ENOTSUP. */
  posix(inode: Inode): PosixMetadata | undefined;
  /** The overlay's own records: lower paths deleted above, and files still being staged. */
  isLowerPathHidden(path: string): boolean;
  isStagingPath(path: string): boolean;
}

export interface SnapshotStorage extends Storage {
  /** Fails with E2BIG past `maxEntries` names, so a tree too large to index is never held whole. */
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
