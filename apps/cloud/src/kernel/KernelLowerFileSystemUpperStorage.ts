import type { PosixMetadata } from "./PosixStorage.ts";
import type { Inode, Storage } from "./storage.ts";

/** Persistent namespace state lets the overlay hide renamed lower paths after a reopen. */
export interface KernelLowerFileSystemUpperStorage {
  readonly lowerOverlay: {
    isLowerPathHidden(path: string): boolean;
    isStagingPath(path: string): boolean;
    createStagingFile(parent: Inode, name: string, path: string, metadata: PosixMetadata): Inode;
    publishStagingFile(input: {
      readonly stageParent: Inode;
      readonly stageName: string;
      readonly stagePath: string;
      readonly targetParent: Inode;
      readonly targetName: string;
      readonly replaceExisting: boolean;
      readonly hiddenLowerPath?: string;
    }): Inode;
    discardStagingFile(parent: Inode, name: string, path: string): void;
    renameFileWithWhiteout(
      fromParent: Inode,
      fromName: string,
      toParent: Inode,
      toName: string,
      hiddenLowerPath: string,
    ): void;
    unlinkFileWithWhiteout(parent: Inode, name: string, hiddenLowerPath: string): void;
  };
}

export function lowerFileSystemUpperStorage(
  storage: Storage,
): KernelLowerFileSystemUpperStorage["lowerOverlay"] | undefined {
  if (!("lowerOverlay" in storage)) return undefined;
  const value = (storage as Storage & { readonly lowerOverlay?: unknown }).lowerOverlay;
  if (typeof value !== "object" || value === null) return undefined;
  const methods = [
    "isLowerPathHidden",
    "isStagingPath",
    "createStagingFile",
    "publishStagingFile",
    "discardStagingFile",
    "renameFileWithWhiteout",
    "unlinkFileWithWhiteout",
  ] as const;
  return methods.every((method) => typeof (value as Record<string, unknown>)[method] === "function")
    ? (value as KernelLowerFileSystemUpperStorage["lowerOverlay"])
    : undefined;
}
