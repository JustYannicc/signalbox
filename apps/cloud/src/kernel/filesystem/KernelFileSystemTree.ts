import type { KernelLowerFileSystemTree, KernelTreeNode } from "../KernelLowerFileSystemTree.ts";
import { childPath } from "../KernelLowerFileSystemSourceIndex.ts";
import type { PosixMetadata } from "../PosixStorage.ts";
import { kernelError } from "./KernelFileSystemErrors.ts";
import type { KernelStat } from "./KernelFileSystemTypes.ts";
import type { KernelPosix } from "./KernelPosix.ts";
import { descriptorPathSuffix, posixPathAlias } from "./KernelPathAliases.ts";
import { virtualDevice } from "./KernelVirtualDevices.ts";

export interface KernelTreeEntry {
  readonly path: string;
  readonly stat: KernelStat;
  /** Absent for a path the kernel synthesizes, which only its per-path calls answer. */
  readonly node?: KernelTreeNode;
}

/** The per-path calls this tree stands in for. */
export interface KernelTreePaths {
  lstat(path: string): Promise<KernelStat>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): string;
}

/**
 * The tree as `lstatAsync`, `readdirAsync` and `readlink` report it, read from one snapshot of
 * storage: the same denials, inodes and metadata, without resolving every path from the root.
 * A caller walks it from the root, so each directory it reads was searchable all the way down.
 * Paths the kernel synthesizes, devices and descriptor aliases, still take the per-path calls.
 */
export class KernelFileSystemTree {
  readonly #tree: KernelLowerFileSystemTree;
  readonly #device: bigint;
  readonly #posix: KernelPosix;
  readonly #paths: KernelTreePaths;
  readonly #run: <T>(signal: AbortSignal, run: () => Promise<T>) => Promise<T>;

  constructor(options: {
    readonly tree: KernelLowerFileSystemTree;
    readonly device: bigint;
    readonly posix: KernelPosix;
    readonly paths: KernelTreePaths;
    readonly run: <T>(signal: AbortSignal, run: () => Promise<T>) => Promise<T>;
  }) {
    this.#tree = options.tree;
    this.#device = options.device;
    this.#posix = options.posix;
    this.#paths = options.paths;
    this.#run = options.run;
  }

  /** Runs a batch of reads as one kernel operation, which the lower layer's reads expect. */
  run<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return this.#run(signal, run);
  }

  async root(signal?: AbortSignal): Promise<KernelTreeEntry> {
    const node = this.#tree.root;
    return { path: node.path, stat: await this.#stat(node, signal), node };
  }

  async readdir(directory: KernelTreeEntry, signal?: AbortSignal): Promise<readonly string[]> {
    const node = directory.node;
    if (node === undefined) return this.#paths.readdir(directory.path);
    if (directory.stat.type !== "directory") throw kernelError("ENOTDIR");
    this.#check(directory, 4);
    return this.#tree.names(node, signal);
  }

  async lstat(
    directory: KernelTreeEntry,
    name: string,
    signal?: AbortSignal,
  ): Promise<KernelTreeEntry> {
    const path = childPath(directory.path, name);
    if (directory.node === undefined || synthesized(path))
      return { path, stat: await this.#paths.lstat(path) };
    this.#check(directory, 1);
    const node = await this.#tree.lookup(directory.node, name, signal);
    return { path, stat: await this.#stat(node, signal), node };
  }

  async readlink(entry: KernelTreeEntry, signal?: AbortSignal): Promise<string> {
    return entry.node === undefined
      ? this.#paths.readlink(entry.path)
      : this.#tree.readlink(entry.node, signal);
  }

  /** The metadata `checkAccessAsync` would read is the directory's own, already in its stat. */
  #check(directory: KernelTreeEntry, requested: number) {
    if (this.#posix.credentials === undefined) return;
    const metadata = directory.stat.posix;
    if (metadata === undefined) throw kernelError("ENOTSUP");
    this.#posix.checkMetadataAccess(metadata, "directory", requested, true);
  }

  async #stat(node: KernelTreeNode, signal?: AbortSignal): Promise<KernelStat> {
    const stat = await this.#tree.stat(node, signal);
    let posix: PosixMetadata | undefined;
    try {
      posix = await this.#tree.metadata(node, signal);
    } catch (error) {
      if (!isCode(error, "ENOTSUP")) throw error;
    }
    return {
      ...stat,
      ino: node.inode,
      dev: this.#device,
      ...this.#tree.native(node),
      ...(posix === undefined ? {} : { posix }),
    };
  }
}

const synthesized = (path: string) =>
  virtualDevice(path) !== undefined ||
  posixPathAlias(path) !== undefined ||
  descriptorPathSuffix(path) !== undefined;

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
