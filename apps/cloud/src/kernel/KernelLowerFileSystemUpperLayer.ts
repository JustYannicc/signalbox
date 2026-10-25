import type { MaybePosixStorage, PosixMetadata } from "./PosixStorage.ts";
import type { KernelLowerFileSystemKnownLookup } from "./KernelLowerFileSystem.ts";
import type { CreateOptions, Inode, MaybePromise, Storage, Times } from "./storage.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

export interface KernelLowerFileSystemUpperNamespace {
  hasLowerSource(): boolean;
  isLowerInode(inode: Inode): boolean;
  upperDirectoryPath(inode: Inode): string | undefined;
  lookupLower(path: string): MaybePromise<Inode>;
  lookupLowerKnown(path: string): KernelLowerFileSystemKnownLookup;
  lowerMetadata(inode: Inode): MaybePromise<PosixMetadata>;
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
    this.#assertUpper(inode);
    return this.#storage.write(inode, offset, source);
  }

  append(inode: Inode, source: Uint8Array): MaybePromise<{ offset: bigint; bytesWritten: number }> {
    this.#assertUpper(inode);
    return this.#storage.append(inode, source);
  }

  truncate(inode: Inode, size: bigint): MaybePromise<void> {
    this.#assertUpper(inode);
    return this.#storage.truncate(inode, size);
  }

  setTimes(inode: Inode, times: Times): MaybePromise<void> {
    this.#assertUpper(inode);
    return this.#storage.setTimes(inode, times);
  }

  sync(inode: Inode, dataOnly: boolean): MaybePromise<void> {
    if (this.#namespace.isLowerInode(inode)) return;
    return this.#storage.sync(inode, dataOnly);
  }

  create(parent: Inode, name: string, options: CreateOptions): MaybePromise<Inode> {
    return this.#createUpper(parent, name, options.exclusive, () =>
      this.#storage.create(parent, name, options),
    );
  }

  link(inode: Inode, parent: Inode, name: string): MaybePromise<void> {
    this.#assertUpper(inode);
    this.#assertUpper(parent);
    if (this.#namespace.upperDirectoryPath(parent) === undefined) throw kernelError("ENOTDIR");
    return this.#storage.link(inode, parent, name);
  }

  unlink(parent: Inode, name: string, options: { directory: boolean }): MaybePromise<void> {
    this.#assertUpper(parent);
    const parentPath = this.#namespace.upperDirectoryPath(parent);
    if (parentPath === undefined) throw kernelError("ENOTDIR");
    const path = childPath(parentPath, name);
    try {
      this.#storage.lookup(parent, name);
      this.#storage.unlink(parent, name, options);
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
    this.#assertUpper(fromParent);
    this.#assertUpper(toParent);
    const fromParentPath = this.#namespace.upperDirectoryPath(fromParent);
    const toParentPath = this.#namespace.upperDirectoryPath(toParent);
    if (fromParentPath === undefined || toParentPath === undefined) throw kernelError("ENOTDIR");
    const fromPath = childPath(fromParentPath, fromName);
    const toPath = childPath(toParentPath, toName);
    try {
      this.#storage.lookup(fromParent, fromName);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      return lowerMutationError(this.#namespace.lookupLower(fromPath));
    }
    this.#storage.rename(fromParent, fromName, toParent, toName);
    this.#namespace.moveUpperPaths(fromPath, toPath);
  }

  #posixGet(inode: Inode): MaybePromise<PosixMetadata> {
    if (this.#namespace.isLowerInode(inode)) return this.#namespace.lowerMetadata(inode);
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
      () => posix.create(parent, name, options),
      true,
    );
  }

  #posixChmod(inode: Inode, mode: number): MaybePromise<void> {
    this.#assertUpper(inode);
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return posix.chmod(inode, mode);
  }

  #posixChown(inode: Inode, owner: Pick<PosixMetadata, "uid" | "gid">): MaybePromise<void> {
    this.#assertUpper(inode);
    const posix = upperPosix(this.#storage);
    if (posix === undefined) throw kernelError("ENOTSUP");
    return posix.chown(inode, owner);
  }

  #createUpper(
    parent: Inode,
    name: string,
    exclusive: boolean,
    create: () => MaybePromise<Inode>,
    synchronous = false,
  ): MaybePromise<Inode> {
    this.#assertUpper(parent);
    const parentPath = this.#namespace.upperDirectoryPath(parent);
    if (parentPath === undefined) throw kernelError("ENOTDIR");
    const path = childPath(parentPath, name);
    const createAndRemember = (): MaybePromise<Inode> => {
      const inode = create();
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
