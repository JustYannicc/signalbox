import type { MaybePosixStorage } from "./PosixStorage.ts";
import type { PosixMetadata } from "./PosixStorage.ts";
import type { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";
import {
  basename,
  childPath,
  parentPath,
  pathComponents,
} from "./KernelLowerFileSystemSourceIndex.ts";
import { currentKernelSignal } from "./process/KernelExecution.ts";
import type { Inode, MaybePromise, Stat, Storage } from "./storage.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

/** Owns overlay directory identity and copies lower-only parents into writable storage. */
export class KernelLowerFileSystemDirectoryLayer {
  readonly #upper: Storage;
  readonly #source: () => KernelLowerFileSystemSourceIndex | undefined;
  readonly #pathByUpperDirectory = new Map<Inode, string>();
  readonly #upperDirectoryByPath = new Map<string, Inode>();

  constructor(upper: Storage, source: () => KernelLowerFileSystemSourceIndex | undefined) {
    this.#upper = upper;
    this.#source = source;
    this.#rememberUpperPath("/", upper.root);
  }

  upperPath(inode: Inode): string | undefined {
    return this.#pathByUpperDirectory.get(inode);
  }

  lowerPath(inode: Inode): string | undefined {
    return this.#source()?.pathForInode(inode);
  }

  upperDirectoryAt(path: string): Inode | undefined {
    const cached = this.#upperDirectoryByPath.get(path);
    if (cached !== undefined) {
      try {
        if (this.#upper.stat(cached).type === "directory") return cached;
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      this.forgetUpperPath(path);
    }

    let current = this.#upper.root;
    let currentPath = "/";
    for (const component of pathComponents(path)) {
      try {
        current = this.#upper.lookup(current, component);
      } catch (error) {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      }
      currentPath = childPath(currentPath, component);
      if (this.#upper.stat(current).type !== "directory") throw kernelError("ENOTDIR");
      this.#rememberUpperPath(currentPath, current);
    }
    return current;
  }

  copyUpDirectory(inode: Inode): MaybePromise<Inode> {
    const source = this.#source();
    if (source === undefined || !source.isInode(inode)) {
      if (this.#pathByUpperDirectory.has(inode)) return inode;
      throw kernelError("ENOTDIR");
    }
    const path = source.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    return this.#copyUpPath(source, path);
  }

  rememberUpper(path: string, inode: Inode): void {
    try {
      if (this.#upper.stat(inode).type === "directory") this.#rememberUpperPath(path, inode);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  moveUpperPaths(fromPath: string, toPath: string): void {
    if (fromPath === toPath) return;
    const moved = [...this.#pathByUpperDirectory.entries()].filter(
      ([, path]) => path === fromPath || path.startsWith(`${fromPath}/`),
    );
    for (const [inode, path] of moved) {
      if (this.#upperDirectoryByPath.get(path) === inode) this.#upperDirectoryByPath.delete(path);
    }
    for (const [inode, path] of moved) {
      this.#rememberUpperPath(`${toPath}${path.slice(fromPath.length)}`, inode);
    }
  }

  forgetUpperPath(path: string): void {
    for (const [inode, current] of this.#pathByUpperDirectory) {
      if (current === path || current.startsWith(`${path}/`)) {
        this.#pathByUpperDirectory.delete(inode);
        if (this.#upperDirectoryByPath.get(current) === inode)
          this.#upperDirectoryByPath.delete(current);
      }
    }
  }

  #copyUpPath(source: KernelLowerFileSystemSourceIndex, path: string): MaybePromise<Inode> {
    const existing = this.upperDirectoryAt(path);
    if (existing !== undefined) return existing;
    if (path === "/") return this.#upper.root;

    const signal = currentKernelSignal();
    return flatMapMaybe(source.lookup(path, signal), (lowerInode) => {
      if (lowerInode === undefined) throw kernelError("ENOENT");
      return flatMapMaybe(source.stat(lowerInode, signal), (stat) => {
        if (stat.type !== "directory") throw kernelError("ENOTDIR");
        return flatMapMaybe(source.metadata(lowerInode, signal), (metadata) =>
          flatMapMaybe(this.#copyUpPath(source, parentPath(path)), (upperParent) =>
            this.#createUpperDirectory(path, upperParent, stat, metadata),
          ),
        );
      });
    });
  }

  #createUpperDirectory(
    path: string,
    parent: Inode,
    stat: Stat,
    metadata: PosixMetadata,
  ): MaybePromise<Inode> {
    const posix = upperPosix(this.#upper);
    if (posix === undefined) throw kernelError("ENOTSUP");
    let created: MaybePromise<Inode>;
    try {
      created = posix.create(parent, basename(path), {
        type: "directory",
        exclusive: true,
        metadata,
      });
    } catch (error) {
      return this.#existingAfterRace(path, error);
    }

    const remember = (inode: Inode) => {
      try {
        this.#upper.setTimes(inode, { atimeNs: stat.atimeNs, mtimeNs: stat.mtimeNs });
        this.#rememberUpperPath(path, inode);
        return inode;
      } finally {
        this.#upper.release(inode);
      }
    };
    return isPromiseLike(created)
      ? created.then(remember, (error) => this.#existingAfterRace(path, error))
      : remember(created);
  }

  #existingAfterRace(path: string, error: unknown): Inode {
    if (!isCode(error, "EEXIST")) throw error;
    const existing = this.upperDirectoryAt(path);
    if (existing === undefined) throw error;
    return existing;
  }

  #rememberUpperPath(path: string, inode: Inode): void {
    const oldPath = this.#pathByUpperDirectory.get(inode);
    if (
      oldPath !== undefined &&
      oldPath !== path &&
      this.#upperDirectoryByPath.get(oldPath) === inode
    )
      this.#upperDirectoryByPath.delete(oldPath);
    const oldInode = this.#upperDirectoryByPath.get(path);
    if (oldInode !== undefined && oldInode !== inode) this.#pathByUpperDirectory.delete(oldInode);
    this.#pathByUpperDirectory.set(inode, path);
    this.#upperDirectoryByPath.set(path, inode);
  }
}

function upperPosix(storage: Storage): MaybePosixStorage["posix"] | undefined {
  if (!("posix" in storage)) return undefined;
  const value = (storage as Storage & { readonly posix?: unknown }).posix;
  if (typeof value !== "object" || value === null || !("create" in value)) return undefined;
  return typeof value.create === "function" ? (value as MaybePosixStorage["posix"]) : undefined;
}

function flatMapMaybe<A, B>(
  value: MaybePromise<A>,
  f: (value: A) => MaybePromise<B>,
): MaybePromise<B> {
  return isPromiseLike(value) ? value.then(f) : f(value);
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
