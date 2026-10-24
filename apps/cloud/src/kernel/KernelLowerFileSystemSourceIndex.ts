import { isPosixMetadata } from "./PosixStorage.ts";
import type { PosixMetadata } from "./PosixStorage.ts";
import {
  KernelFileSystemUnavailable,
  type KernelLowerFileSystemEntry,
  type KernelLowerFileSystemKnownLookup,
  type KernelLowerFileSystemSource,
} from "./KernelLowerFileSystem.ts";
import { currentKernelIoMode, currentKernelSignal } from "./process/KernelExecution.ts";
import type { DirectoryEntry, Inode, MaybePromise, Stat } from "./storage.ts";
import { kernelError } from "./filesystem/KernelFileSystemErrors.ts";

const MAX_EPOCH_RETRIES = 1;

/** Positive lower metadata and inode identity shared by the overlay's mount forks. */
export class KernelLowerFileSystemSourceIndex {
  readonly #source: KernelLowerFileSystemSource;
  readonly #allocateInode: () => Inode;
  readonly #entryByPath = new Map<string, KernelLowerFileSystemEntry>();
  readonly #missingPaths = new Set<string>();
  readonly #linkByPath = new Map<string, string>();
  readonly #directoryByPath = new Map<string, readonly DirectoryEntry[]>();
  readonly #lowerInodeByPath = new Map<string, Inode>();
  readonly #lowerPathsByInode = new Map<Inode, Set<string>>();
  readonly #lowerInodesByIdentity = new Map<string, Inode>();
  #epoch = 0;

  constructor(source: KernelLowerFileSystemSource, allocateInode: () => Inode) {
    this.#source = source;
    this.#allocateInode = allocateInode;
  }

  get source(): KernelLowerFileSystemSource {
    return this.#source;
  }

  get epoch(): number {
    return this.#epoch;
  }

  isInode(inode: Inode): boolean {
    return this.#lowerPathsByInode.has(inode);
  }

  pathForInode(inode: Inode): string | undefined {
    return this.#lowerPathsByInode.get(inode)?.values().next().value;
  }

  symlinkParent(inode: Inode): string | undefined {
    const path = this.pathForInode(inode);
    return path === undefined ? undefined : this.#entryByPath.get(path)?.symlinkParent;
  }

  cachedEntry(path: string): KernelLowerFileSystemEntry | undefined {
    return this.#entryByPath.get(path);
  }

  lookup(path: string, signal?: AbortSignal): MaybePromise<Inode | undefined> {
    const cached = this.#entryByPath.get(path);
    if (cached !== undefined) return this.#cacheEntry(path, cached);
    if (this.#missingPaths.has(path)) return undefined;
    const entry = this.#entry(path, signal);
    const inode = (found: KernelLowerFileSystemEntry | undefined) => {
      if (found === undefined) return undefined;
      const identity = this.#lowerInodeByPath.get(path);
      if (identity === undefined)
        throw new KernelFileSystemUnavailable("Lower inode identity is missing");
      return identity;
    };
    return isPromiseLike(entry) ? entry.then(inode) : inode(entry);
  }

  lookupKnown(path: string): KernelLowerFileSystemKnownLookup {
    const cached = this.#entryByPath.get(path);
    if (cached !== undefined) return { kind: "entry", inode: this.#cacheEntry(path, cached) };
    if (this.#missingPaths.has(path)) return { kind: "missing" };
    if (this.#source.lookupKnown === undefined) return { kind: "unknown" };
    canonicalPath(path);

    let entries: readonly (KernelLowerFileSystemEntry | undefined)[] | undefined;
    try {
      entries = this.#source.lookupKnown([path]);
    } catch (error) {
      throw sourceFailure(error, true);
    }
    if (entries === undefined) return { kind: "unknown" };
    if (!Array.isArray(entries) || entries.length !== 1) {
      throw new KernelFileSystemUnavailable("Lower known-lookup result length mismatch");
    }
    const entry = entries[0];
    if (entry === undefined) {
      this.#missingPaths.add(path);
      return { kind: "missing" };
    }
    try {
      validateEntry(path, entry);
    } catch (error) {
      throw new KernelFileSystemUnavailable("Lower known-lookup returned invalid metadata", {
        cause: error,
      });
    }
    return { kind: "entry", inode: this.#cacheEntry(path, entry) };
  }

  stat(inode: Inode, signal?: AbortSignal): MaybePromise<Stat> {
    const path = this.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    const cached = this.#entryByPath.get(path);
    if (cached !== undefined) return cached.stat;
    const entry = this.#entry(path, signal);
    const stat = (found: KernelLowerFileSystemEntry | undefined) => {
      if (found === undefined) throw kernelError("ENOENT");
      return found.stat;
    };
    return isPromiseLike(entry) ? entry.then(stat) : stat(entry);
  }

  metadata(inode: Inode, signal?: AbortSignal): MaybePromise<PosixMetadata> {
    const path = this.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    const cached = this.#entryByPath.get(path);
    if (cached !== undefined) return cached.metadata;
    const entry = this.#entry(path, signal);
    const metadata = (found: KernelLowerFileSystemEntry | undefined) => {
      if (found === undefined) throw kernelError("ENOENT");
      return found.metadata;
    };
    return isPromiseLike(entry) ? entry.then(metadata) : metadata(entry);
  }

  nativeMetadata(
    inode: Inode,
  ): { readonly nativeIno?: bigint; readonly nativeDev?: bigint } | undefined {
    const path = this.pathForInode(inode);
    const entry = path === undefined ? undefined : this.#entryByPath.get(path);
    if (entry === undefined || nativeIdentity(entry) === undefined) return undefined;
    return {
      ...(entry.nativeIno === undefined ? {} : { nativeIno: entry.nativeIno }),
      ...(entry.nativeDev === undefined ? {} : { nativeDev: entry.nativeDev }),
    };
  }

  readlink(inode: Inode, signal?: AbortSignal): MaybePromise<string> {
    const path = this.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    return this.#readlink(path, signal);
  }

  readInto(inode: Inode, offset: bigint, target: Uint8Array): MaybePromise<number> {
    const path = this.pathForInode(inode);
    if (path === undefined) throw kernelError("ENOENT");
    if (offset < 0n) throw kernelError("EINVAL");
    if (target.byteLength === 0) return 0;
    if (currentKernelIoMode() === "sync") {
      throw kernelError("ENOTSUP", "Lower file bytes require asynchronous execution");
    }
    return this.#readBytes(path, offset, target, currentKernelSignal());
  }

  readdir(path: string, signal?: AbortSignal): MaybePromise<readonly DirectoryEntry[] | undefined> {
    const cached = this.#directoryByPath.get(path);
    if (cached !== undefined) return cached;
    const entry = this.#entryByPath.get(path);
    if (entry !== undefined) return this.#readDirectory(path, entry, signal);
    const found = this.#entry(path, signal);
    const read = (directory: KernelLowerFileSystemEntry | undefined) =>
      directory === undefined ? undefined : this.#readDirectory(path, directory, signal);
    return isPromiseLike(found) ? found.then(read) : read(found);
  }

  async prepare(
    paths: readonly string[],
    signal?: AbortSignal,
    skip: (path: string) => boolean = () => false,
  ): Promise<void> {
    const explicit = new Set<string>();
    const requested = new Set<string>();
    for (const path of paths) {
      // Only the POSIX walk knows which parent follows a symlink before `..`.
      if (typeof path === "string" && pathComponents(path).includes("..")) continue;
      const canonical = normalizePreparedPath(path);
      explicit.add(canonical);
      requested.add(canonical);
      const components = pathComponents(canonical);
      for (let index = 1; index < components.length; index++) {
        requested.add(`/${components.slice(0, index).join("/")}`);
      }
    }
    const ordered = [...requested].filter(
      (path) => !skip(path) && !this.#entryByPath.has(path) && !this.#missingPaths.has(path),
    );
    if (ordered.length > 0) {
      await this.#lookupBatch(ordered, signal ?? currentKernelSignal(), (entries) => {
        for (let index = 0; index < ordered.length; index++) {
          const path = ordered[index];
          const entry = entries[index];
          if (path !== undefined && entry !== undefined) this.#cacheEntry(path, entry);
        }
      });
    }

    const explicitEntries = [...explicit].filter((path) => !skip(path));
    await Promise.all(
      explicitEntries.map(async (path) => {
        const entry = this.#entryByPath.get(path);
        if (entry?.stat.type === "symlink") await this.#readlink(path, signal);
        if (entry?.stat.type === "directory") await this.#readDirectory(path, entry, signal);
      }),
    );
  }

  invalidate(): void {
    this.#epoch++;
    this.#entryByPath.clear();
    this.#missingPaths.clear();
    this.#linkByPath.clear();
    this.#directoryByPath.clear();
  }

  #entry(path: string, signal?: AbortSignal): MaybePromise<KernelLowerFileSystemEntry | undefined> {
    const cached = this.#entryByPath.get(path);
    if (cached !== undefined) return cached;
    if (this.#missingPaths.has(path)) return undefined;
    if (currentKernelIoMode() === "sync") {
      const known = this.lookupKnown(path);
      if (known.kind === "missing") return undefined;
      if (known.kind === "entry") return this.#entryByPath.get(path);
      throw kernelError("ENOTSUP", "Lower metadata requires asynchronous execution");
    }
    return this.#lookupBatch([path], signal ?? currentKernelSignal(), (batch) => {
      const entry = batch[0];
      if (entry !== undefined) this.#cacheEntry(path, entry);
      return entry;
    });
  }

  #lookupBatch<T>(
    paths: readonly string[],
    signal: AbortSignal | undefined,
    consume: (entries: readonly (KernelLowerFileSystemEntry | undefined)[]) => T,
    attempt = 0,
  ): MaybePromise<T> {
    for (const path of paths) canonicalPath(path);
    if (currentKernelIoMode() === "sync") {
      throw kernelError("ENOTSUP", "Lower lookup requires asynchronous execution");
    }
    const activeSignal = signal ?? currentKernelSignal();
    const epoch = this.#epoch;
    const validate = (entries: readonly (KernelLowerFileSystemEntry | undefined)[]) => {
      if (!Array.isArray(entries) || entries.length !== paths.length) {
        throw new KernelFileSystemUnavailable("Lower lookup result length mismatch");
      }
      for (let index = 0; index < entries.length; index++) {
        const path = paths[index];
        const entry = entries[index];
        if (path !== undefined && entry === undefined) {
          this.#missingPaths.add(path);
        } else if (entry !== undefined && path !== undefined) {
          try {
            validateEntry(path, entry);
          } catch (error) {
            throw new KernelFileSystemUnavailable("Lower lookup returned invalid metadata", {
              cause: error,
            });
          }
        }
      }
      return consume(entries);
    };
    const retry = () =>
      this.#retryAfterInvalidation(attempt, activeSignal, "lookup", () =>
        this.#lookupBatch(paths, activeSignal, consume, attempt + 1),
      );
    const accept = (entries: readonly (KernelLowerFileSystemEntry | undefined)[]) => {
      activeSignal?.throwIfAborted();
      return epoch === this.#epoch ? validate(entries) : retry();
    };
    const reject = (error: unknown) => {
      activeSignal?.throwIfAborted();
      if (epoch !== this.#epoch) return retry();
      throw sourceFailure(error, true);
    };
    let entries: MaybePromise<readonly (KernelLowerFileSystemEntry | undefined)[]>;
    try {
      entries = this.#source.lookup(paths, activeSignal);
    } catch (error) {
      return reject(error);
    }
    return isPromiseLike(entries) ? entries.then(accept, reject) : accept(entries);
  }

  #readlink(path: string, signal?: AbortSignal, attempt = 0): MaybePromise<string> {
    const cached = this.#linkByPath.get(path);
    if (cached !== undefined) return cached;
    if (currentKernelIoMode() === "sync") {
      throw kernelError("ENOTSUP", "Lower symlink targets require asynchronous execution");
    }
    const activeSignal = signal ?? currentKernelSignal();
    const epoch = this.#epoch;
    const retry = () =>
      this.#retryAfterInvalidation(attempt, activeSignal, "readlink", () =>
        this.#readlink(path, activeSignal, attempt + 1),
      );
    return sourceCall(() => this.#source.readlink(path, activeSignal)).then(
      (target) => {
        activeSignal?.throwIfAborted();
        if (epoch !== this.#epoch) return retry();
        if (typeof target !== "string") {
          throw new KernelFileSystemUnavailable("Lower readlink returned invalid data");
        }
        this.#linkByPath.set(path, target);
        return target;
      },
      (error) => {
        activeSignal?.throwIfAborted();
        if (epoch !== this.#epoch) return retry();
        throw error;
      },
    );
  }

  #readDirectory(
    path: string,
    entry: KernelLowerFileSystemEntry,
    signal?: AbortSignal,
    attempt = 0,
  ): MaybePromise<readonly DirectoryEntry[] | undefined> {
    if (this.#entryByPath.get(path) !== entry) {
      return this.#readDirectoryFresh(path, signal ?? currentKernelSignal(), attempt);
    }
    if (entry.stat.type !== "directory" && entry.stat.type !== "symlink") return undefined;
    if (currentKernelIoMode() === "sync") {
      throw kernelError("ENOTSUP", "Lower directory entries require asynchronous execution");
    }
    const activeSignal = signal ?? currentKernelSignal();
    const epoch = this.#epoch;
    const retry = () =>
      this.#retryAfterInvalidation(attempt, activeSignal, "readdir", () =>
        this.#readDirectoryFresh(path, activeSignal, attempt + 1),
      );
    return sourceCall(() => this.#source.readdir(path, activeSignal), true).then(
      (entries) => {
        activeSignal?.throwIfAborted();
        if (epoch !== this.#epoch) return retry();
        if (entries === undefined) return undefined;
        if (!Array.isArray(entries)) {
          throw new KernelFileSystemUnavailable("Lower readdir returned invalid entries");
        }
        const result = entries.map((child) => {
          if (typeof child !== "object" || child === null || typeof child.path !== "string") {
            throw new KernelFileSystemUnavailable("Lower readdir returned an invalid entry");
          }
          let childCanonical: string;
          try {
            childCanonical = canonicalPath(child.path);
          } catch (error) {
            throw new KernelFileSystemUnavailable("Lower readdir returned a non-canonical path", {
              cause: error,
            });
          }
          const name = basename(childCanonical);
          if (
            name === "" ||
            name === "." ||
            name === ".." ||
            childPath(path, name) !== childCanonical
          ) {
            throw new KernelFileSystemUnavailable("Lower readdir returned a non-child path");
          }
          try {
            validateEntry(childCanonical, child);
          } catch (error) {
            throw new KernelFileSystemUnavailable("Lower readdir returned invalid metadata", {
              cause: error,
            });
          }
          return {
            name,
            inode: this.#cacheEntry(childCanonical, child),
            type: child.stat.type,
          } satisfies DirectoryEntry;
        });
        this.#directoryByPath.set(path, result);
        return result;
      },
      (error) => {
        activeSignal?.throwIfAborted();
        if (epoch !== this.#epoch) return retry();
        throw error;
      },
    );
  }

  #readDirectoryFresh(
    path: string,
    signal: AbortSignal | undefined,
    attempt: number,
  ): MaybePromise<readonly DirectoryEntry[] | undefined> {
    const cached = this.#entryByPath.get(path);
    if (cached !== undefined) return this.#readDirectory(path, cached, signal, attempt);
    const found = this.#entry(path, signal);
    const read = (entry: KernelLowerFileSystemEntry | undefined) =>
      entry === undefined ? undefined : this.#readDirectory(path, entry, signal, attempt);
    return isPromiseLike(found) ? found.then(read) : read(found);
  }

  #readBytes(
    path: string,
    offset: bigint,
    target: Uint8Array,
    signal: AbortSignal | undefined,
    attempt = 0,
  ): Promise<number> {
    const activeSignal = signal ?? currentKernelSignal();
    const epoch = this.#epoch;
    const retry = () =>
      this.#retryAfterInvalidation(attempt, activeSignal, "read", () =>
        this.#readBytes(path, offset, target, activeSignal, attempt + 1),
      );
    return sourceCall(() => this.#source.read(path, offset, target.byteLength, activeSignal)).then(
      (bytes) => {
        activeSignal?.throwIfAborted();
        if (epoch !== this.#epoch) return retry();
        if (!(bytes instanceof Uint8Array)) {
          throw new KernelFileSystemUnavailable("Lower read returned invalid bytes");
        }
        if (bytes.byteLength > target.byteLength) {
          throw new KernelFileSystemUnavailable("Lower read exceeded the requested length");
        }
        target.set(bytes);
        return bytes.byteLength;
      },
      (error) => {
        activeSignal?.throwIfAborted();
        if (epoch !== this.#epoch) return retry();
        throw error;
      },
    );
  }

  #retryAfterInvalidation<T>(
    attempt: number,
    signal: AbortSignal | undefined,
    operation: string,
    retry: () => MaybePromise<T>,
  ): MaybePromise<T> {
    signal?.throwIfAborted();
    if (attempt >= MAX_EPOCH_RETRIES) {
      throw new KernelFileSystemUnavailable(
        `Lower filesystem changed repeatedly during ${operation}`,
      );
    }
    return retry();
  }

  #cacheEntry(path: string, entry: KernelLowerFileSystemEntry): Inode {
    const identity = nativeIdentity(entry);
    let inode =
      identity === undefined
        ? this.#lowerInodeByPath.get(path)
        : this.#lowerInodesByIdentity.get(identity);
    if (inode === undefined) {
      inode = this.#allocateInode();
      if (identity !== undefined) this.#lowerInodesByIdentity.set(identity, inode);
    }
    this.#lowerInodeByPath.set(path, inode);
    const paths = this.#lowerPathsByInode.get(inode) ?? new Set<string>();
    paths.add(path);
    this.#lowerPathsByInode.set(inode, paths);
    this.#entryByPath.set(path, entry);
    return inode;
  }
}

export function canonicalPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw kernelError("EINVAL");
  }
  const components = pathComponents(path);
  if (components.some((part) => part === "." || part === "..")) throw kernelError("EINVAL");
  const canonical = components.length === 0 ? "/" : `/${components.join("/")}`;
  if (canonical !== path)
    throw kernelError("EINVAL", "Lower paths must be canonical absolute paths");
  return canonical;
}

function normalizePreparedPath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw kernelError("EINVAL");
  }
  const components: string[] = [];
  for (const component of pathComponents(path)) {
    if (component === ".") continue;
    if (component === "..") {
      components.pop();
      continue;
    }
    components.push(component);
  }
  return components.length === 0 ? "/" : `/${components.join("/")}`;
}

export function pathComponents(path: string): string[] {
  if (!path.startsWith("/") || path.includes("\0")) throw kernelError("EINVAL");
  return path.split("/").filter((component) => component !== "");
}

export function childPath(parent: string, name: string): string {
  validateName(name);
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === 0 ? "/" : path.slice(0, separator);
}

function validateEntry(path: string, entry: KernelLowerFileSystemEntry): void {
  if (entry.path !== path || !isPosixMetadata(entry.metadata)) {
    throw new TypeError("Lower filesystem returned invalid entry metadata");
  }
  const stat = entry.stat;
  if (entry.symlinkParent !== undefined) {
    if (stat.type !== "symlink" || canonicalPath(entry.symlinkParent) !== entry.symlinkParent)
      throw new TypeError("Lower filesystem returned invalid symlink parent");
  }
  if (
    !["file", "directory", "symlink"].includes(stat.type) ||
    stat.size < 0n ||
    stat.nlink < 0n ||
    typeof stat.atimeNs !== "bigint" ||
    typeof stat.mtimeNs !== "bigint" ||
    typeof stat.ctimeNs !== "bigint"
  ) {
    throw new TypeError("Lower filesystem returned invalid stat data");
  }
  for (const value of [entry.nativeIno, entry.nativeDev]) {
    if (value !== undefined && value < 0n)
      throw new TypeError("Lower filesystem returned invalid identity");
  }
}

function nativeIdentity(entry: KernelLowerFileSystemEntry): string | undefined {
  if (
    entry.nativeIno === undefined ||
    entry.nativeDev === undefined ||
    entry.nativeIno <= 0n ||
    entry.nativeDev <= 0n
  )
    return undefined;
  return `${entry.nativeDev}:${entry.nativeIno}`;
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

function sourceCall<T>(operation: () => Promise<T>, lookup = false): Promise<T> {
  try {
    return Promise.resolve(operation()).catch((error) => {
      throw sourceFailure(error, lookup);
    });
  } catch (error) {
    return Promise.reject(sourceFailure(error, lookup));
  }
}

function sourceFailure(error: unknown, lookup = false): Error {
  if (error instanceof KernelFileSystemUnavailable) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  // Only a returned undefined is a lookup miss. A rejected ENOENT could be a
  // source failure and must not let shell search turn backend failure into 127.
  if (lookup && code === "ENOENT") {
    return new KernelFileSystemUnavailable("Lower filesystem lookup failed", { cause: error });
  }
  if (code !== undefined && /^E[A-Z0-9]+$/.test(code)) {
    return error instanceof Error ? error : Object.assign(new Error(code), { code });
  }
  return new KernelFileSystemUnavailable("Lower filesystem source failed", {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}
