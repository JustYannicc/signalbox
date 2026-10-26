import type { MaybePosixStorage, PosixMetadata } from "./PosixStorage.ts";
import type { KernelLowerFileSystemKnownLookup } from "./KernelLowerFileSystem.ts";
import type { CreateOptions, Inode, MaybePromise, Stat, Storage, Times } from "./storage.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";
import { currentKernelIoMode } from "./process/KernelExecution.ts";

export interface KernelLowerFileSystemUpperNamespace {
  hasLowerSource(): boolean;
  isLowerInode(inode: Inode): boolean;
  upperDirectoryPath(inode: Inode): string | undefined;
  copyUpDirectory(inode: Inode): MaybePromise<Inode>;
  lookupLower(path: string): MaybePromise<Inode>;
  lookupLowerKnown(path: string): KernelLowerFileSystemKnownLookup;
  lowerStat(inode: Inode): MaybePromise<Stat>;
  lowerMetadata(inode: Inode): MaybePromise<PosixMetadata>;
  upperFileForLowerInode(inode: Inode): Inode | undefined;
  copyUpFile(inode: Inode, copyData: boolean): Promise<Inode>;
  copyUpFileSync(inode: Inode): Inode;
  renameLowerFile(
    inode: Inode,
    fromParent: Inode,
    fromName: string,
    toParent: Inode,
    toName: string,
  ): Promise<void>;
  renameUpperFileWithWhiteout(
    fromParent: Inode,
    fromName: string,
    toParent: Inode,
    toName: string,
    lowerPath: string,
  ): void;
  unlinkUpperFileWithWhiteout(parent: Inode, name: string, lowerPath: string): void;
  isLowerPathHidden(path: string): boolean;
  isStagingPath(path: string): boolean;
  rememberUpper(path: string, inode: Inode): void;
  forgetUpperPath(path: string): void;
  moveUpperPaths(fromPath: string, toPath: string): void;
}

/** Mutable operations are confined to upper storage and share the overlay's namespace checks. */
export class KernelLowerFileSystemUpperLayer {
  readonly #storage: Storage;
  readonly #namespace: KernelLowerFileSystemUpperNamespace;
  readonly posix: MaybePosixStorage["posix"];

  constructor(storage: Storage, namespace: KernelLowerFileSystemUpperNamespace) {
    this.#storage = storage;
    this.#namespace = namespace;
    this.posix = {
      get: (inode) => this.#posixGet(inode),
      initialize: (inode, metadata) => this.#posixInitialize(inode, metadata),
      create: (parent, name, options) => this.#posixCreate(parent, name, options),
      chmod: (inode, mode) => this.#posixChmod(inode, mode),
      chown: (inode, owner) => this.#posixChown(inode, owner),
    };
  }

  write(inode: Inode, offset: bigint, source: Uint8Array): MaybePromise<number> {
    return this.#storage.write(this.#upperFile(inode), offset, source);
  }

  append(inode: Inode, source: Uint8Array): MaybePromise<{ offset: bigint; bytesWritten: number }> {
    return this.#storage.append(this.#upperFile(inode), source);
  }

  truncate(inode: Inode, size: bigint): MaybePromise<void> {
    return this.#storage.truncate(this.#upperFile(inode), size);
  }

  setTimes(inode: Inode, times: Times): MaybePromise<void> {
    return this.#storage.setTimes(this.#upperFile(inode), times);
  }

  sync(inode: Inode, dataOnly: boolean): MaybePromise<void> {
    const upper = this.#namespace.upperFileForLowerInode(inode);
    if (this.#namespace.isLowerInode(inode) && upper === undefined) return;
    return this.#storage.sync(upper ?? inode, dataOnly);
  }

  create(parent: Inode, name: string, options: CreateOptions): MaybePromise<Inode> {
    return this.#createUpper(parent, name, options.exclusive, (upperParent) =>
      this.#storage.create(upperParent, name, options),
    );
  }

  link(inode: Inode, parent: Inode, name: string): MaybePromise<void> {
    this.#assertUpper(inode);
    return mapMaybe(this.#namespace.copyUpDirectory(parent), (upperParent) => {
      this.#assertUpper(upperParent);
      if (this.#namespace.upperDirectoryPath(upperParent) === undefined)
        throw kernelError("ENOTDIR");
      return this.#storage.link(inode, upperParent, name);
    });
  }

  unlink(parent: Inode, name: string, options: { directory: boolean }): MaybePromise<void> {
    this.#assertUpper(parent);
    const parentPath = this.#namespace.upperDirectoryPath(parent);
    if (parentPath === undefined) throw kernelError("ENOTDIR");
    const path = childPath(parentPath, name);
    try {
      this.#storage.lookup(parent, name);
      const lower = options.directory
        ? { kind: "missing" }
        : this.#namespace.lookupLowerKnown(path);
      if (lower.kind === "entry") this.#namespace.unlinkUpperFileWithWhiteout(parent, name, path);
      else this.#storage.unlink(parent, name, options);
      this.#namespace.forgetUpperPath(path);
      return;
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    try {
      return lowerMutationError(this.#namespace.lookupLower(path));
    } catch (error) {
      if (isCode(error, "ENOENT")) throw error;
      throw error;
    }
  }

  rename(fromParent: Inode, fromName: string, toParent: Inode, toName: string): MaybePromise<void> {
    return mapMaybe(this.#namespace.copyUpDirectory(fromParent), (upperFromParent) =>
      mapMaybe(this.#namespace.copyUpDirectory(toParent), (upperToParent) => {
        this.#assertUpper(upperFromParent);
        this.#assertUpper(upperToParent);
        const fromParentPath = this.#namespace.upperDirectoryPath(upperFromParent);
        const toParentPath = this.#namespace.upperDirectoryPath(upperToParent);
        if (fromParentPath === undefined || toParentPath === undefined)
          throw kernelError("ENOTDIR");
        const fromPath = childPath(fromParentPath, fromName);
        const toPath = childPath(toParentPath, toName);
        if (fromPath === toPath) return;
        try {
          this.#storage.lookup(upperFromParent, fromName);
          return mapMaybe(lookupLowerOptional(this.#namespace, fromPath), (lowerSource) => {
            if (lowerSource === undefined) {
              this.#storage.rename(upperFromParent, fromName, upperToParent, toName);
              this.#namespace.forgetUpperPath(toPath);
              this.#namespace.moveUpperPaths(fromPath, toPath);
              return;
            }
            return mapMaybe(this.#namespace.lowerStat(lowerSource), (lowerStat) => {
              if (lowerStat.type !== "file") {
                this.#storage.rename(upperFromParent, fromName, upperToParent, toName);
              } else {
                return mapMaybe(
                  this.#validateLowerDestination(lowerStat, upperToParent, toName, toPath),
                  () =>
                    this.#namespace.renameUpperFileWithWhiteout(
                      upperFromParent,
                      fromName,
                      upperToParent,
                      toName,
                      fromPath,
                    ),
                );
              }
              this.#namespace.forgetUpperPath(toPath);
              this.#namespace.moveUpperPaths(fromPath, toPath);
            });
          });
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw error;
        }
        return mapMaybe(this.#namespace.lookupLower(fromPath), (lowerSource) =>
          mapMaybe(this.#namespace.lowerStat(lowerSource), (lowerStat) => {
            if (lowerStat.type !== "file") return lowerMutationError(lowerSource);
            if (currentKernelIoMode() === "sync")
              throw kernelError("EXDEV", "Lower file rename requires asynchronous execution");
            return mapMaybe(
              this.#validateLowerDestination(lowerStat, upperToParent, toName, toPath),
              () =>
                this.#namespace.renameLowerFile(
                  lowerSource,
                  upperFromParent,
                  fromName,
                  upperToParent,
                  toName,
                ),
            );
          }),
        );
      }),
    );
  }

  #posixGet(inode: Inode): MaybePromise<PosixMetadata> {
    if (this.#namespace.isLowerInode(inode)) {
      const upper = this.#namespace.upperFileForLowerInode(inode);
      if (upper === undefined) return this.#namespace.lowerMetadata(inode);
      const posix = upperPosix(this.#storage);
      if (posix === undefined) throw kernelError("ENOTSUP");
      return posix.get(upper);
    }
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return posix.get(inode);
  }

  #posixInitialize(inode: Inode, metadata: PosixMetadata): MaybePromise<void> {
    this.#assertUpper(inode);
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return posix.initialize(inode, metadata);
  }

  #posixCreate(
    parent: Inode,
    name: string,
    options: CreateOptions & { metadata: PosixMetadata },
  ): MaybePromise<Inode> {
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return this.#createUpper(
      parent,
      name,
      options.exclusive,
      (upperParent) => posix.create(upperParent, name, options),
      currentKernelIoMode() === "sync",
    );
  }

  #posixChmod(inode: Inode, mode: number): MaybePromise<void> {
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return posix.chmod(this.#upperFile(inode), mode);
  }

  #posixChown(inode: Inode, owner: Pick<PosixMetadata, "uid" | "gid">): MaybePromise<void> {
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return posix.chown(this.#upperFile(inode), owner);
  }

  #createUpper(
    parent: Inode,
    name: string,
    exclusive: boolean,
    create: (parent: Inode) => MaybePromise<Inode>,
    synchronous = false,
  ): MaybePromise<Inode> {
    return mapMaybe(this.#namespace.copyUpDirectory(parent), (upperParent) =>
      this.#createInUpper(upperParent, name, exclusive, create, synchronous),
    );
  }

  #createInUpper(
    parent: Inode,
    name: string,
    exclusive: boolean,
    create: (parent: Inode) => MaybePromise<Inode>,
    synchronous: boolean,
  ): MaybePromise<Inode> {
    this.#assertUpper(parent);
    const parentPath = this.#namespace.upperDirectoryPath(parent);
    if (parentPath === undefined) throw kernelError("ENOTDIR");
    const path = childPath(parentPath, name);
    const createAndRemember = (): MaybePromise<Inode> => {
      const inode = create(parent);
      if (typeof inode === "bigint") {
        this.#namespace.rememberUpper(path, inode);
        return inode;
      }
      return inode.then((created) => {
        this.#namespace.rememberUpper(path, created);
        return created;
      });
    };

    if (!exclusive || !this.#namespace.hasLowerSource()) return createAndRemember();
    try {
      this.#storage.lookup(parent, name);
      return createAndRemember();
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    if (synchronous) {
      const known = this.#namespace.lookupLowerKnown(path);
      if (known.kind === "entry") throw kernelError("EEXIST");
      if (known.kind === "missing") return createAndRemember();
      throw kernelError("ENOTSUP", "Synchronous creation cannot check a live lower path");
    }
    let lower: MaybePromise<Inode>;
    try {
      lower = this.#namespace.lookupLower(path);
    } catch (error) {
      if (isCode(error, "ENOENT")) return createAndRemember();
      throw error;
    }
    if (isPromiseLike(lower)) {
      return lower.then(
        () => {
          throw kernelError("EEXIST");
        },
        (error: unknown) => {
          if (isCode(error, "ENOENT")) return createAndRemember();
          throw error;
        },
      );
    }
    throw kernelError("EEXIST");
  }

  #assertUpper(inode: Inode): void {
    if (this.#namespace.isLowerInode(inode)) throw kernelError("EROFS");
  }

  #upperFile(inode: Inode): Inode {
    if (!this.#namespace.isLowerInode(inode)) return inode;
    const upper = this.#namespace.upperFileForLowerInode(inode);
    if (upper === undefined) throw kernelError("EROFS");
    return upper;
  }

  #validateLowerDestination(
    sourceStat: Stat,
    upperParent: Inode,
    name: string,
    path: string,
  ): MaybePromise<void> {
    try {
      this.#storage.lookup(upperParent, name);
      return;
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    return mapMaybe(lookupLowerOptional(this.#namespace, path), (destination) => {
      if (destination === undefined) return;
      return mapMaybe(this.#namespace.lowerStat(destination), (destinationStat) => {
        if (sourceStat.type === "file" && destinationStat.type === "directory")
          throw kernelError("EISDIR");
        if (sourceStat.type === "directory" && destinationStat.type !== "directory")
          throw kernelError("ENOTDIR");
      });
    });
  }
}

function upperPosix(storage: Storage): MaybePosixStorage["posix"] | undefined {
  if (!("posix" in storage)) return undefined;
  const value = (storage as Storage & { readonly posix?: unknown }).posix;
  if (typeof value !== "object" || value === null) return undefined;
  const methods = ["get", "initialize", "create", "chmod", "chown"] as const;
  return methods.every((method) => typeof (value as Record<string, unknown>)[method] === "function")
    ? (value as MaybePosixStorage["posix"])
    : undefined;
}

function childPath(parent: string, name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw kernelError("EINVAL");
  }
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function lowerMutationError(lower: MaybePromise<Inode>): MaybePromise<void> {
  if (isPromiseLike(lower)) {
    return lower.then(
      () => {
        throw kernelError("EROFS");
      },
      (error: unknown) => {
        if (isCode(error, "ENOENT")) throw error;
        throw error;
      },
    );
  }
  throw kernelError("EROFS");
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function lookupLowerOptional(
  namespace: KernelLowerFileSystemUpperNamespace,
  path: string,
): MaybePromise<Inode | undefined> {
  try {
    const lower = namespace.lookupLower(path);
    return isPromiseLike(lower)
      ? lower.then(
          (inode) => inode,
          (error: unknown) => {
            if (isCode(error, "ENOENT")) return undefined;
            throw error;
          },
        )
      : lower;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function mapMaybe<A, B>(value: MaybePromise<A>, f: (value: A) => MaybePromise<B>): MaybePromise<B> {
  return isPromiseLike(value) ? value.then(f) : f(value);
}
