import type { MaybePosixStorage } from "./PosixStorage.ts";
import type {
  KernelLowerFileSystem,
  KernelLowerFileSystemKnownLookup,
  KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";
import {
  KernelLowerFileSystemUpperLayer,
  type KernelLowerFileSystemUpperNamespace,
} from "./KernelLowerFileSystemUpperLayer.ts";
import { KernelLowerFileSystemDirectoryLayer } from "./KernelLowerFileSystemDirectoryLayer.ts";
import { KernelLowerFileSystemFileLayer } from "./KernelLowerFileSystemFileLayer.ts";
import { lowerFileSystemUpperStorage } from "./KernelLowerFileSystemUpperStorage.ts";
import type {
  CreateOptions,
  DirectoryEntry,
  Inode,
  MaybeAsyncStorage,
  MaybePromise,
  Stat,
  Storage,
  Times,
} from "./storage.ts";
import { currentKernelSignal } from "./process/KernelExecution.ts";
import type {
  WasiDirectoryEdgeStorage,
  WasiSymlinkParentStorage,
} from "./wasi/internal_wasi_paths.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";
import {
  basename,
  childPath,
  parentPath,
  pathComponents,
} from "./KernelLowerFileSystemSourceIndex.ts";

const FIRST_LOWER_INODE = 1n << 63n;
const MAX_WASI_INODE = (1n << 64n) - 1n;
const MAX_SYMLINKS = 40;

/** Merges a live read-only source below one synchronous upper storage. */
export class KernelLowerFileSystemStorage
  implements MaybeAsyncStorage, WasiDirectoryEdgeStorage, WasiSymlinkParentStorage
{
  readonly root: Inode;
  readonly #upper: Storage;
  readonly #directories: KernelLowerFileSystemDirectoryLayer;
  readonly #files: KernelLowerFileSystemFileLayer;
  readonly #overlayUpper: ReturnType<typeof lowerFileSystemUpperStorage>;
  readonly #invalidationHooks = new Set<() => void>();
  readonly #upperLayer: KernelLowerFileSystemUpperLayer;
  readonly posix: MaybePosixStorage["posix"];
  #sourceIndex: KernelLowerFileSystemSourceIndex | undefined;
  #attachmentToken: symbol | undefined;
  #nextLowerInode = FIRST_LOWER_INODE;

  constructor(upper: Storage) {
    this.root = upper.root;
    this.#upper = upper;
    this.#directories = new KernelLowerFileSystemDirectoryLayer(upper, () => this.#sourceIndex);
    this.#overlayUpper = lowerFileSystemUpperStorage(upper);
    this.#files = new KernelLowerFileSystemFileLayer(
      upper,
      this.#overlayUpper,
      this.#directories,
      () => this.#sourceIndex,
    );
    const namespace: KernelLowerFileSystemUpperNamespace = {
      hasLowerSource: () => this.#sourceIndex !== undefined,
      isLowerInode: (inode) => this.isLowerInode(inode),
      upperDirectoryPath: (inode) => this.#directories.upperPath(inode),
      copyUpDirectory: (inode) => this.#directories.copyUpDirectory(inode),
      lookupLower: (path) => this.#lookupLower(path),
      lookupLowerKnown: (path) => this.#lookupLowerKnown(path),
      lowerStat: (inode) => this.#requireIndex().stat(inode),
      lowerMetadata: (inode) => this.#requireIndex().metadata(inode),
      upperFileForLowerInode: (inode) => this.#files.upperInodeForLower(inode),
      copyUpFile: (inode, copyData) => this.#files.copyUpFile(inode, copyData),
      copyUpFileSync: (inode) => this.#files.copyUpFileSync(inode),
      renameLowerFile: (inode, fromParent, fromName, toParent, toName) =>
        this.#files.renameLowerFile(inode, fromParent, fromName, toParent, toName),
      renameUpperFileWithWhiteout: (fromParent, fromName, toParent, toName, path) =>
        this.#files.renameUpperFileWithWhiteout(fromParent, fromName, toParent, toName, path),
      unlinkUpperFileWithWhiteout: (parent, name, path) =>
        this.#files.unlinkUpperFileWithWhiteout(parent, name, path),
      isLowerPathHidden: (path) => this.#overlayUpper?.isLowerPathHidden(path) ?? false,
      isStagingPath: (path) => this.#overlayUpper?.isStagingPath(path) ?? false,
      rememberUpper: (path, inode) => this.#directories.rememberUpper(path, inode),
      forgetUpperPath: (path) => this.#directories.forgetUpperPath(path),
      moveUpperPaths: (fromPath, toPath) => this.#directories.moveUpperPaths(fromPath, toPath),
    };
    this.#upperLayer = new KernelLowerFileSystemUpperLayer(upper, namespace);
    this.posix = this.#upperLayer.posix;
  }

  attach(source: KernelLowerFileSystemSource): KernelLowerFileSystem {
    if (this.#sourceIndex !== undefined) throw kernelError("EEXIST");
    const token = Symbol("KernelLowerFileSystem.attachment");
    const index = new KernelLowerFileSystemSourceIndex(source, () => {
      if (this.#nextLowerInode > MAX_WASI_INODE) throw kernelError("EMFILE");
      return this.#nextLowerInode++;
    });
    this.#attachmentToken = token;
    this.#sourceIndex = index;
    return {
      prepare: (paths, signal) => this.#prepare(token, paths, signal),
      refresh: (paths, signal) => this.#refresh(token, paths, signal),
      isLower: (path, signal) => {
        this.#assertAttachment(token);
        return this.isLower(path, signal);
      },
      invalidate: () => {
        if (this.#attachmentToken === token) this.invalidate();
      },
      dispose: () => this.#detach(token),
    };
  }

  registerInvalidationHook(hook: () => void): () => void {
    this.#invalidationHooks.add(hook);
    return () => this.#invalidationHooks.delete(hook);
  }

  prepare(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    return (
      this.#sourceIndex?.prepare(paths, signal, (path) => this.#upperBlocksSource(path)) ??
      Promise.resolve()
    );
  }

  changeGeneration(): number | undefined {
    if (this.#sourceIndex !== undefined) return undefined;
    return hasChangeGeneration(this.#upper) ? this.#upper.changeGeneration() : undefined;
  }

  isLowerInode(inode: Inode): boolean {
    return this.#sourceIndex?.isInode(inode) ?? false;
  }

  byteViewStorage(inode: Inode): Storage | undefined {
    return this.isLowerInode(inode) ? undefined : this.#upper;
  }

  nativeMetadata(
    inode: Inode,
  ): { readonly nativeIno?: bigint; readonly nativeDev?: bigint } | undefined {
    return this.#sourceIndex?.nativeMetadata(inode);
  }

  copyUpFile(inode: Inode, copyData: boolean): Promise<Inode> {
    if (!this.isLowerInode(inode)) return Promise.resolve(inode);
    return this.#files.copyUpFile(inode, copyData);
  }

  copyUpFileSync(inode: Inode): Inode {
    if (!this.isLowerInode(inode)) return inode;
    return this.#files.copyUpFileSync(inode);
  }

  invalidate(): void {
    this.#sourceIndex?.invalidate();
    for (const hook of this.#invalidationHooks) hook();
  }

  lookup(parent: Inode, name: string): MaybePromise<Inode> {
    return this.#lookupFromParent(parent, name, currentKernelSignal());
  }

  #lookupFromParent(parent: Inode, name: string, signal?: AbortSignal): MaybePromise<Inode> {
    validateName(name);
    const upperParentPath = this.#directories.upperPath(parent);
    const lowerParentPath = this.#lowerPath(parent);
    const parentPath = lowerParentPath ?? upperParentPath;
    if (parentPath === undefined) throw kernelError("ENOENT");
    const path = childPath(parentPath, name);

    const upperParent =
      upperParentPath !== undefined
        ? parent
        : lowerParentPath === undefined
          ? undefined
          : this.#directories.upperDirectoryAt(lowerParentPath);
    if (upperParent !== undefined) {
      try {
        const inode = this.#upper.lookup(upperParent, name);
        if (!this.#overlayUpper?.isStagingPath(path)) {
          this.#directories.rememberUpper(path, inode);
          return inode;
        }
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    return this.#lookupLower(path, signal);
  }

  stat(inode: Inode): MaybePromise<Stat> {
    const upperFile = this.#files.upperInodeForLower(inode);
    if (upperFile !== undefined) return this.#upper.stat(upperFile);
    if (!this.isLowerInode(inode)) return this.#upper.stat(inode);
    const lower = this.#requireIndex().stat(inode, currentKernelSignal());
    const useUpperDirectory = (stat: Stat): Stat => {
      if (stat.type !== "directory") return stat;
      const path = this.#lowerPath(inode);
      if (path === undefined) return stat;
      const upper = this.#directories.upperDirectoryAt(path);
      return upper === undefined ? stat : this.#upper.stat(upper);
    };
    return isPromiseLike(lower) ? lower.then(useUpperDirectory) : useUpperDirectory(lower);
  }

  readlink(inode: Inode): MaybePromise<string> {
    return this.isLowerInode(inode)
      ? this.#requireIndex().readlink(inode, currentKernelSignal())
      : this.#upper.readlink(inode);
  }

  symlinkParent(inode: Inode): string | undefined {
    return this.#sourceIndex?.symlinkParent(inode);
  }

  readdir(inode: Inode): MaybePromise<DirectoryEntry[]> {
    const lowerPath = this.#lowerPath(inode);
    if (lowerPath !== undefined) {
      const upperDirectory = this.#directories.upperDirectoryAt(lowerPath);
      const upperEntries =
        upperDirectory === undefined ? [] : this.#visibleUpperEntries(lowerPath, upperDirectory);
      const entries = this.#requireIndex().readdir(lowerPath, currentKernelSignal());
      const merge = (lower: readonly DirectoryEntry[] | undefined) => {
        if (lower === undefined) {
          if (upperDirectory !== undefined) return upperEntries;
          throw kernelError("ENOENT");
        }
        return mergeDirectoryEntries(upperEntries, this.#visibleLowerEntries(lowerPath, lower));
      };
      return isPromiseLike(entries) ? entries.then(merge) : merge(entries);
    }

    const upperPath = this.#directories.upperPath(inode);
    const upperEntries =
      upperPath === undefined
        ? this.#upper.readdir(inode)
        : this.#visibleUpperEntries(upperPath, inode);
    if (upperPath === undefined || this.#sourceIndex === undefined) return upperEntries;
    const lower = this.#sourceIndex.readdir(upperPath, currentKernelSignal());
    return isPromiseLike(lower)
      ? lower.then((entries) =>
          mergeDirectoryEntries(upperEntries, this.#visibleLowerEntries(upperPath, entries)),
        )
      : mergeDirectoryEntries(upperEntries, this.#visibleLowerEntries(upperPath, lower));
  }

  directoryEntry(parent: Inode, child: Inode): MaybePromise<DirectoryEntry | undefined> {
    const lowerParentPath = this.#lowerPath(parent);
    if (lowerParentPath !== undefined) {
      const upperParent = this.#directories.upperDirectoryAt(lowerParentPath);
      if (upperParent !== undefined) {
        const upperEntry = this.#upperDirectoryEntry(upperParent, lowerParentPath, child);
        if (upperEntry !== undefined) return upperEntry ?? undefined;
      }
      return this.#lowerDirectoryEntry(lowerParentPath, child);
    }

    const upperParentPath = this.#directories.upperPath(parent);
    if (upperParentPath === undefined) return undefined;
    const upperEntry = this.#upperDirectoryEntry(parent, upperParentPath, child);
    if (upperEntry !== undefined) return upperEntry ?? undefined;
    return this.#lowerDirectoryEntry(upperParentPath, child);
  }

  retain(inode: Inode): MaybePromise<void> {
    if (this.isLowerInode(inode)) {
      this.#files.retainLower(inode);
      return;
    }
    return this.#upper.retain(inode);
  }

  release(inode: Inode): MaybePromise<void> {
    if (this.isLowerInode(inode)) {
      this.#files.releaseLower(inode);
      return;
    }
    return this.#upper.release(inode);
  }

  readInto(inode: Inode, offset: bigint, target: Uint8Array): MaybePromise<number> {
    const upperFile = this.#files.upperInodeForLower(inode);
    if (upperFile !== undefined) return this.#upper.readInto(upperFile, offset, target);
    if (this.isLowerInode(inode)) return this.#requireIndex().readInto(inode, offset, target);
    return this.#upper.readInto(inode, offset, target);
  }

  write(inode: Inode, offset: bigint, source: Uint8Array): MaybePromise<number> {
    return this.#upperLayer.write(inode, offset, source);
  }

  append(inode: Inode, source: Uint8Array): MaybePromise<{ offset: bigint; bytesWritten: number }> {
    return this.#upperLayer.append(inode, source);
  }

  truncate(inode: Inode, size: bigint): MaybePromise<void> {
    return this.#upperLayer.truncate(inode, size);
  }

  setTimes(inode: Inode, times: Times): MaybePromise<void> {
    return this.#upperLayer.setTimes(inode, times);
  }

  sync(inode: Inode, dataOnly: boolean): MaybePromise<void> {
    return this.#upperLayer.sync(inode, dataOnly);
  }

  create(parent: Inode, name: string, options: CreateOptions): MaybePromise<Inode> {
    return this.#upperLayer.create(parent, name, options);
  }

  link(inode: Inode, parent: Inode, name: string): MaybePromise<void> {
    return this.#upperLayer.link(inode, parent, name);
  }

  unlink(parent: Inode, name: string, options: { directory: boolean }): MaybePromise<void> {
    return this.#upperLayer.unlink(parent, name, options);
  }

  rename(fromParent: Inode, fromName: string, toParent: Inode, toName: string): MaybePromise<void> {
    return this.#upperLayer.rename(fromParent, fromName, toParent, toName);
  }

  async isLower(path: string, signal?: AbortSignal): Promise<boolean> {
    const pending = pathComponents(path);
    const stack: Inode[] = [this.root];
    let links = 0;
    let requireDirectory = path.endsWith("/");
    while (pending.length > 0) {
      const component = pending.shift();
      if (component === undefined || component === "" || component === ".") continue;
      if (component === "..") {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const parent = stack[stack.length - 1];
      if (parent === undefined) throw kernelError("ENOENT");
      const inode = await this.#lookupFromParent(parent, component, signal);
      const stat = await (this.isLowerInode(inode)
        ? this.#requireIndex().stat(inode, signal)
        : this.#upper.stat(inode));
      if (stat.type === "symlink") {
        if (++links > MAX_SYMLINKS) throw kernelError("ELOOP");
        const target = await (this.isLowerInode(inode)
          ? this.#requireIndex().readlink(inode, signal)
          : this.#upper.readlink(inode));
        if (target.length === 0 || target.includes("\0")) throw kernelError("EINVAL");
        const targetComponents = target.split("/").filter((part) => part !== "");
        if (pending.length === 0 && pathRequiresDirectory(target)) requireDirectory = true;
        const parentPath = target.startsWith("/") ? undefined : this.symlinkParent(inode);
        if (target.startsWith("/") || parentPath !== undefined) stack.splice(1);
        pending.unshift(...(parentPath?.split("/").filter(Boolean) ?? []), ...targetComponents);
        continue;
      }
      if (pending.length > 0 || requireDirectory) {
        if (stat.type !== "directory") throw kernelError("ENOTDIR");
        stack.push(inode);
      } else {
        return this.isLowerInode(inode);
      }
    }
    return this.isLowerInode(stack.at(-1) ?? this.root);
  }

  #lookupLower(path: string, signal?: AbortSignal): MaybePromise<Inode> {
    const index = this.#sourceIndex;
    if (index === undefined || this.#overlayUpper?.isLowerPathHidden(path))
      throw kernelError("ENOENT");
    const result = index.lookup(path, signal);
    if (isPromiseLike(result)) {
      return result.then((inode) => {
        if (inode === undefined) throw kernelError("ENOENT");
        return inode;
      });
    }
    if (result === undefined) throw kernelError("ENOENT");
    return result;
  }

  #lookupLowerKnown(path: string): KernelLowerFileSystemKnownLookup {
    const index = this.#sourceIndex;
    return index === undefined || this.#overlayUpper?.isLowerPathHidden(path)
      ? { kind: "missing" }
      : index.lookupKnown(path);
  }

  #lowerDirectoryEntry(parent: string, child: Inode): MaybePromise<DirectoryEntry | undefined> {
    const index = this.#sourceIndex;
    const path = index?.pathForInode(child);
    if (
      index === undefined ||
      path === undefined ||
      parentPath(path) !== parent ||
      this.#overlayUpper?.isLowerPathHidden(path)
    )
      return undefined;
    const cached = index.cachedEntry(path);
    if (cached !== undefined) {
      return cached.stat.type === "directory"
        ? { name: basename(path), inode: child, type: "directory" }
        : undefined;
    }
    const stat = index.stat(child);
    const directoryEntry = (resolved: Stat): DirectoryEntry | undefined =>
      resolved.type === "directory"
        ? { name: basename(path), inode: child, type: "directory" }
        : undefined;
    return isPromiseLike(stat) ? stat.then(directoryEntry) : directoryEntry(stat);
  }

  #upperDirectoryEntry(
    parent: Inode,
    parentPathValue: string,
    child: Inode,
  ): DirectoryEntry | null | undefined {
    const entries = this.#visibleUpperEntries(parentPathValue, parent);
    const byInode = entries.find((entry) => entry.inode === child);
    if (byInode !== undefined) return byInode.type === "directory" ? byInode : null;

    const lowerPath = this.#lowerPath(child);
    if (lowerPath === undefined || parentPath(lowerPath) !== parentPathValue) return undefined;
    const byName = entries.find((entry) => entry.name === basename(lowerPath));
    if (byName === undefined) return undefined;
    return byName.type === "directory" ? byName : null;
  }

  #lowerPath(inode: Inode): string | undefined {
    return this.#directories.lowerPath(inode);
  }

  #visibleUpperEntries(path: string, directory: Inode): DirectoryEntry[] {
    return this.#upper
      .readdir(directory)
      .filter((entry) => !this.#overlayUpper?.isStagingPath(childPath(path, entry.name)));
  }

  #visibleLowerEntries(
    path: string,
    entries: readonly DirectoryEntry[] | undefined,
  ): readonly DirectoryEntry[] | undefined {
    return entries?.filter(
      (entry) => !this.#overlayUpper?.isLowerPathHidden(childPath(path, entry.name)),
    );
  }

  #requireIndex(): KernelLowerFileSystemSourceIndex {
    if (this.#sourceIndex === undefined)
      throw kernelError("ENOTSUP", "No lower filesystem is installed");
    return this.#sourceIndex;
  }

  #prepare(token: symbol, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    this.#assertAttachment(token);
    return this.prepare(paths, signal);
  }

  #refresh(token: symbol, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    this.#assertAttachment(token);
    const index = this.#requireIndex();
    this.invalidate();
    const epoch = index.epoch;
    return index
      .refresh(paths, signal, (path) => this.#upperBlocksSourceDuringRefresh(path))
      .catch((error: unknown) => {
        if (this.#attachmentToken === token && this.#sourceIndex === index && index.epoch === epoch)
          this.invalidate();
        throw error;
      });
  }

  #upperBlocksSource(path: string): boolean {
    if (path === "/") return false;
    if (this.#overlayUpper?.isLowerPathHidden(path)) return true;
    let current = this.#upper.root;
    let currentPath = "/";
    const components = pathComponents(path);
    for (let index = 0; index < components.length; index++) {
      const component = components[index];
      if (component === undefined) return true;
      currentPath = childPath(currentPath, component);
      if (this.#overlayUpper?.isStagingPath(currentPath)) return false;
      try {
        current = this.#upper.lookup(current, component);
      } catch (error) {
        if (isCode(error, "ENOENT")) return false;
        throw error;
      }
      const stat = this.#upper.stat(current);
      if (index === components.length - 1) return true;
      if (stat.type !== "directory") return true;
    }
    return false;
  }

  #upperBlocksSourceDuringRefresh(path: string): boolean {
    if (!this.#upperBlocksSource(path)) return false;
    if (this.#overlayUpper?.isLowerPathHidden(path)) return true;
    try {
      return this.#directories.upperDirectoryAt(path) === undefined;
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "ENOTDIR")) return true;
      throw error;
    }
  }

  #detach(token: symbol): void {
    if (this.#attachmentToken !== token) return;
    const index = this.#sourceIndex;
    this.#attachmentToken = undefined;
    this.#sourceIndex = undefined;
    index?.invalidate();
    for (const hook of this.#invalidationHooks) hook();
  }

  #assertAttachment(token: symbol): void {
    if (this.#attachmentToken !== token)
      throw kernelError("ESTALE", "Lower filesystem handle is detached");
  }
}

export function isKernelLowerFileSystemInode(storage: unknown, inode: Inode): boolean {
  return storage instanceof KernelLowerFileSystemStorage && storage.isLowerInode(inode);
}

export function kernelFileByteViewStorage(
  storage: Storage | MaybeAsyncStorage,
  inode: Inode,
): Storage | MaybeAsyncStorage | undefined {
  return storage instanceof KernelLowerFileSystemStorage ? storage.byteViewStorage(inode) : storage;
}

export function kernelLowerNativeMetadata(
  storage: unknown,
  inode: Inode,
): { readonly nativeIno?: bigint; readonly nativeDev?: bigint } | undefined {
  return storage instanceof KernelLowerFileSystemStorage
    ? storage.nativeMetadata(inode)
    : undefined;
}

function mergeDirectoryEntries(
  upper: DirectoryEntry[],
  lower: readonly DirectoryEntry[] | undefined,
): DirectoryEntry[] {
  if (lower === undefined || lower.length === 0) return upper;
  const names = new Set(upper.map((entry) => entry.name));
  const merged = [...upper];
  for (const entry of lower) {
    if (names.has(entry.name)) continue;
    names.add(entry.name);
    merged.push(entry);
  }
  return merged;
}

function pathRequiresDirectory(path: string): boolean {
  return path.endsWith("/") || path.endsWith("/.") || path.endsWith("/..");
}

function validateName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw kernelError("EINVAL");
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function hasChangeGeneration(
  storage: Storage,
): storage is Storage & { changeGeneration(): number } {
  return "changeGeneration" in storage && typeof storage.changeGeneration === "function";
}
