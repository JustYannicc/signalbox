import { childPath } from "../KernelLowerFileSystemSourceIndex.ts";
import type { Inode } from "../storage.ts";
import type { WasiMountedStorage } from "../wasi/internal_wasi_paths.ts";
import type { KernelFileSystemPaths, ResolvedInode } from "./KernelFileSystemPaths.ts";
import type { KernelStat } from "./KernelFileSystemTypes.ts";
import { resolvesThroughDescriptors } from "./KernelPathAliases.ts";
import { virtualDevice } from "./KernelVirtualDevices.ts";

export interface KernelTreeEntry {
  readonly path: string;
  readonly stat: KernelStat;
  /** Absent for a path the kernel synthesizes, which only its per-path calls answer. */
  readonly resolved?: ResolvedInode;
}

/** The per-path calls the tree stands in for. */
export interface KernelTreePaths {
  lstat(path: string): Promise<KernelStat>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): string;
}

/**
 * The tree as `lstatAsync`, `readdirAsync` and `readlink` report it, read by inode from one
 * snapshot of storage instead of resolving every path again: a child is the parent's own `lookup`,
 * and each step after is the path code's own, run on that inode. Only the parent's search is
 * checked: a caller walks from the root, so each ancestor was searchable when the walk passed it,
 * and a snapshot can't change since. Paths the kernel synthesizes, devices and descriptor aliases,
 * still take the per-path calls.
 */
export class KernelFileSystemTree {
  readonly #mount: WasiMountedStorage;
  readonly #paths: KernelFileSystemPaths;
  readonly #perPath: KernelTreePaths;
  readonly #run: <T>(signal: AbortSignal, run: () => Promise<T>) => Promise<T>;

  constructor(options: {
    readonly mount: WasiMountedStorage;
    readonly paths: KernelFileSystemPaths;
    readonly perPath: KernelTreePaths;
    readonly run: <T>(signal: AbortSignal, run: () => Promise<T>) => Promise<T>;
  }) {
    this.#mount = options.mount;
    this.#paths = options.paths;
    this.#perPath = options.perPath;
    this.#run = options.run;
  }

  /** Runs a batch of reads as one kernel operation, which the lower layer's reads expect. */
  run<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.#run(signal, run);
  }

  root(): Promise<KernelTreeEntry> {
    return this.#entry("/", this.#mount.root);
  }

  async readdir(directory: KernelTreeEntry): Promise<readonly string[]> {
    if (directory.resolved === undefined) return this.#perPath.readdir(directory.path);
    return this.#paths.listDirectoryAsync(directory.resolved);
  }

  async lstat(directory: KernelTreeEntry, name: string): Promise<KernelTreeEntry> {
    const path = childPath(directory.path, name);
    const parent = directory.resolved;
    if (parent === undefined || synthesized(path))
      return { path, stat: await this.#perPath.lstat(path) };
    await this.#paths.searchDirectoryAsync(parent.mount, parent.inode);
    return this.#entry(path, await parent.mount.storage.lookup(parent.inode, name));
  }

  async readlink(entry: KernelTreeEntry): Promise<string> {
    if (entry.resolved === undefined) return this.#perPath.readlink(entry.path);
    return this.#paths.readlinkResolvedAsync(entry.resolved);
  }

  async #entry(path: string, inode: Inode): Promise<KernelTreeEntry> {
    const resolved = { mount: this.#mount, inode, stat: await this.#mount.storage.stat(inode) };
    return { path, stat: await this.#paths.statResolvedAsync(resolved), resolved };
  }
}

const synthesized = (path: string) =>
  virtualDevice(path) !== undefined || resolvesThroughDescriptors(path);
