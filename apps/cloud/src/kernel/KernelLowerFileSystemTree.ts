import type { PosixMetadata } from "./PosixStorage.ts";
import type { KernelStorageSnapshot } from "./KernelStorageSnapshot.ts";
import type { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";
import { childPath, pathComponents } from "./KernelLowerFileSystemSourceIndex.ts";
import type { DirectoryEntry, Inode, MaybePromise, Stat, Storage } from "./storage.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

/** A path as the overlay resolves it: the upper inode where the upper name wins, else the lower. */
export interface KernelTreeNode {
  readonly path: string;
  readonly inode: Inode;
  readonly upper: boolean;
}

/** What the tree needs of the overlay it reads, live, since the lower layer may change under it. */
export interface KernelLowerFileSystemTreeOverlay {
  readonly root: Inode;
  /** Answers for an inode no name reaches, which the snapshot doesn't hold. */
  readonly upper: Storage;
  source(): KernelLowerFileSystemSourceIndex | undefined;
  upperFileForLower(inode: Inode): Inode | undefined;
  nativeMetadata(
    inode: Inode,
  ): { readonly nativeIno?: bigint; readonly nativeDev?: bigint } | undefined;
}

/**
 * The merged tree, read from one snapshot of upper storage. Each method answers as
 * `KernelLowerFileSystemStorage` does through its `lookup`, `readdir`, `stat`, `readlink` and
 * `posix.get`: the upper name wins unless it is still being staged, a lower name deleted above
 * stays hidden, and lower inodes come from the same source index, so they keep their identity.
 * Only the upper reads differ: from memory, instead of a query per path component.
 */
export class KernelLowerFileSystemTree {
  readonly #upper: KernelStorageSnapshot;
  readonly #overlay: KernelLowerFileSystemTreeOverlay;
  readonly #upperDirectories = new Map<string, Inode | undefined>();

  constructor(upper: KernelStorageSnapshot, overlay: KernelLowerFileSystemTreeOverlay) {
    this.#upper = upper;
    this.#overlay = overlay;
  }

  get root(): KernelTreeNode {
    return { path: "/", inode: this.#overlay.root, upper: true };
  }

  /** As `readdir` lists the directory's names. */
  names(directory: KernelTreeNode, signal?: AbortSignal): MaybePromise<readonly string[]> {
    const upperDirectory = directory.upper
      ? directory.inode
      : this.#upperDirectoryAt(directory.path);
    const upper =
      upperDirectory === undefined
        ? []
        : this.#upper
            .children(upperDirectory)
            .filter((entry) => !this.#upper.isStagingPath(childPath(directory.path, entry.name)));
    const source = this.#overlay.source();
    if (source === undefined) {
      if (directory.upper) return upper.map((entry) => entry.name);
      throw kernelError("ENOTSUP", "No lower filesystem is installed");
    }
    const merge = (lower: readonly DirectoryEntry[] | undefined) => {
      if (lower === undefined && upperDirectory === undefined) throw kernelError("ENOENT");
      const names = new Set(upper.map((entry) => entry.name));
      for (const entry of lower ?? []) {
        if (this.#upper.isLowerPathHidden(childPath(directory.path, entry.name))) continue;
        names.add(entry.name);
      }
      return [...names];
    };
    const lower = source.readdir(directory.path, signal);
    return isPromiseLike(lower) ? lower.then(merge) : merge(lower);
  }

  /** As `lookup` resolves a name of the directory. */
  lookup(
    directory: KernelTreeNode,
    name: string,
    signal?: AbortSignal,
  ): MaybePromise<KernelTreeNode> {
    const path = childPath(directory.path, name);
    const upperDirectory = directory.upper
      ? directory.inode
      : this.#upperDirectoryAt(directory.path);
    if (upperDirectory !== undefined) {
      const inode = this.#upper.lookup(upperDirectory, name);
      if (inode !== undefined && !this.#upper.isStagingPath(path))
        return { path, inode, upper: true };
    }
    const source = this.#overlay.source();
    if (source === undefined || this.#upper.isLowerPathHidden(path)) throw kernelError("ENOENT");
    const lower = (inode: Inode | undefined): KernelTreeNode => {
      if (inode === undefined) throw kernelError("ENOENT");
      return { path, inode, upper: false };
    };
    const inode = source.lookup(path, signal);
    return isPromiseLike(inode) ? inode.then(lower) : lower(inode);
  }

  stat(node: KernelTreeNode, signal?: AbortSignal): MaybePromise<Stat> {
    const upperFile = this.#overlay.upperFileForLower(node.inode);
    if (upperFile !== undefined) return this.#upperStat(upperFile);
    if (node.upper) return this.#upperStat(node.inode);
    const source = this.#source();
    // A lower directory with an upper one at its path reports the upper's times and links.
    const merged = (stat: Stat): Stat => {
      if (stat.type !== "directory") return stat;
      const path = source.pathForInode(node.inode);
      const upper = path === undefined ? undefined : this.#upperDirectoryAt(path);
      return upper === undefined ? stat : this.#upperStat(upper);
    };
    const lower = source.stat(node.inode, signal);
    return isPromiseLike(lower) ? lower.then(merged) : merged(lower);
  }

  /** As `posix.get`: a lower inode keeps its own owner unless its file was copied up. */
  metadata(node: KernelTreeNode, signal?: AbortSignal): MaybePromise<PosixMetadata> {
    if (node.upper) return this.#upperMetadata(node.inode);
    const upperFile = this.#overlay.upperFileForLower(node.inode);
    return upperFile === undefined
      ? this.#source().metadata(node.inode, signal)
      : this.#upperMetadata(upperFile);
  }

  readlink(node: KernelTreeNode, signal?: AbortSignal): MaybePromise<string> {
    if (!node.upper) return this.#source().readlink(node.inode, signal);
    return this.#upper.stat(node.inode) === undefined
      ? this.#overlay.upper.readlink(node.inode)
      : this.#upper.readlink(node.inode);
  }

  native(node: KernelTreeNode) {
    return this.#overlay.nativeMetadata(node.inode);
  }

  #upperStat(inode: Inode): Stat {
    return this.#upper.stat(inode) ?? this.#overlay.upper.stat(inode);
  }

  #upperMetadata(inode: Inode): MaybePromise<PosixMetadata> {
    if (this.#upper.stat(inode) === undefined) {
      const posix = upperPosix(this.#overlay.upper);
      if (posix === undefined) throw kernelError("ENOTSUP");
      return posix.get(inode);
    }
    const metadata = this.#upper.posix(inode);
    if (metadata === undefined) throw kernelError("ENOTSUP");
    return metadata;
  }

  /** The upper directory at a lower path, walked by name as the overlay walks it. */
  #upperDirectoryAt(path: string): Inode | undefined {
    if (this.#upperDirectories.has(path)) return this.#upperDirectories.get(path);
    let current = this.#overlay.root;
    for (const component of pathComponents(path)) {
      const next = this.#upper.lookup(current, component);
      if (next === undefined) {
        this.#upperDirectories.set(path, undefined);
        return undefined;
      }
      if (this.#upperStat(next).type !== "directory") throw kernelError("ENOTDIR");
      current = next;
    }
    this.#upperDirectories.set(path, current);
    return current;
  }

  #source(): KernelLowerFileSystemSourceIndex {
    const source = this.#overlay.source();
    if (source === undefined) throw kernelError("ENOTSUP", "No lower filesystem is installed");
    return source;
  }
}

function upperPosix(
  storage: Storage,
): { get(inode: Inode): MaybePromise<PosixMetadata> } | undefined {
  if (!("posix" in storage)) return undefined;
  const posix = (storage as Storage & { readonly posix?: unknown }).posix;
  return typeof posix === "object" && posix !== null && "get" in posix
    ? (posix as { get(inode: Inode): MaybePromise<PosixMetadata> })
    : undefined;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}
