import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import type { KernelStat } from "../../kernel/KernelFileSystem.ts";
import { CliWorkingSetBudget, CliWorkingSetLimit } from "./Budget.ts";
import { CliWriteBarrier } from "./WriteBarrier.ts";

export interface CliFileMetadata {
  readonly path: string;
  readonly stat: KernelStat;
  readonly target?: string;
  /** Computer assigns inode identity when the queued creation commits. */
  readonly pending?: true;
}

export interface CliFileWorkingSetOptions {
  readonly byteLimit: number;
  readonly metadataLimit: number;
  readonly pathByteLimit: number;
}

interface Content {
  bytes: Uint8Array;
  release: () => void;
  pinned: number;
}

function miss(path: string) {
  return Object.assign(new Error(`Synchronous CLI file was not prefetched: ${path}`), {
    code: "CLI_FS_NOT_PREFETCHED",
    path,
  });
}

/** A revision-bound read view. It owns no filesystem, descriptor allocator or storage engine. */
export class CliFileWorkingSet {
  readonly #budget;
  readonly writes;
  readonly #metadata = new Map<string, CliFileMetadata>();
  readonly #content = new Map<string, Content>();
  readonly #prefetching = new Set<string>();
  readonly #options;
  #revision: number | undefined;
  #invalid = false;

  constructor(options: CliFileWorkingSetOptions) {
    for (const value of [options.metadataLimit, options.pathByteLimit])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError("CLI metadata limits must be positive safe integers");
    this.#options = options;
    this.#budget = new CliWorkingSetBudget(options.byteLimit);
    this.writes = new CliWriteBarrier(this.#budget);
  }

  get bytes() {
    return this.#budget.used;
  }
  get revision() {
    this.assertCurrent();
    return this.#revision!;
  }
  get entries() {
    this.assertCurrent();
    return [...this.#metadata.values()];
  }
  get paths() {
    return [...this.#content.keys()];
  }
  assertCurrent() {
    this.writes.assertHealthy();
    if (this.#invalid || this.#revision === undefined)
      throw Object.assign(new Error("CLI filesystem metadata needs refresh"), { code: "ESTALE" });
  }

  replaceMetadata(revision: number, entries: readonly CliFileMetadata[]) {
    this.writes.assertHealthy();
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new TypeError("Invalid Computer filesystem revision");
    if (entries.length > this.#options.metadataLimit)
      throw new CliWorkingSetLimit(entries.length, this.#options.metadataLimit);
    const metadata = new Map<string, CliFileMetadata>();
    const encoder = new TextEncoder();
    for (const entry of entries) {
      if (
        !entry.path.startsWith("/") ||
        encoder.encode(entry.path).byteLength > this.#options.pathByteLimit ||
        metadata.has(entry.path)
      )
        throw new TypeError("Invalid or duplicate CLI metadata path");
      metadata.set(entry.path, {
        ...entry,
        stat: {
          ...entry.stat,
          ...(entry.stat.posix === undefined ? {} : { posix: { ...entry.stat.posix } }),
        },
      });
    }
    if (this.#revision !== revision) this.evictAll();
    this.#metadata.clear();
    for (const [path, entry] of metadata) this.#metadata.set(path, entry);
    this.#revision = revision;
    this.#invalid = false;
  }

  metadata(path: string) {
    this.assertCurrent();
    const entry = this.#metadata.get(path);
    if (entry === undefined)
      throw Object.assign(new Error(`No such file: ${path}`), { code: "ENOENT" });
    return {
      ...entry,
      stat: {
        ...entry.stat,
        ...(entry.stat.posix === undefined ? {} : { posix: { ...entry.stat.posix } }),
      },
    };
  }

  children(path: string) {
    if (this.metadata(path).stat.type !== "directory")
      throw Object.assign(new Error(`Not a directory: ${path}`), { code: "ENOTDIR" });
    const prefix = path === "/" ? "/" : `${path}/`;
    return [...this.#metadata.keys()].flatMap((name) => {
      if (!name.startsWith(prefix)) return [];
      const child = name.slice(prefix.length);
      return child !== "" && !child.includes("/") ? [child] : [];
    });
  }

  content(path: string) {
    this.assertCurrent();
    const entry = this.#content.get(path);
    if (entry === undefined) throw miss(path);
    this.#content.delete(path);
    this.#content.set(path, entry);
    return entry.bytes.slice();
  }

  copyInto(path: string, target: Uint8Array, offset: number) {
    this.assertCurrent();
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RangeError("Invalid CLI file offset");
    const content = this.#content.get(path);
    if (content === undefined) throw miss(path);
    const count = Math.min(target.byteLength, Math.max(0, content.bytes.byteLength - offset));
    target.set(content.bytes.subarray(offset, offset + count));
    return count;
  }

  async prefetch(
    path: string,
    read: (offset: number, length: number, revision: number) => Promise<Uint8Array>,
    signal?: AbortSignal,
  ) {
    const revision = this.revision;
    const stat = this.metadata(path).stat;
    if (stat.type !== "file")
      throw Object.assign(new Error(`Not a regular file: ${path}`), { code: "EISDIR" });
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new CliWorkingSetLimit(Number.POSITIVE_INFINITY, this.#options.byteLimit);
    const size = Number(stat.size);
    if (this.#content.has(path)) return;
    if (this.#prefetching.has(path))
      throw Object.assign(new Error(`CLI prefetch is already active: ${path}`), { code: "EBUSY" });
    this.#makeRoom(size);
    const release = this.#budget.reserve(size);
    this.#prefetching.add(path);
    try {
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size;) {
        signal?.throwIfAborted();
        const length = Math.min(size - offset, KERNEL_SYSCALL_MAX_IO_BYTES);
        const chunk = await read(offset, length, revision);
        if (chunk.byteLength === 0 || chunk.byteLength > length)
          throw new Error("Computer returned an invalid prefetched file range");
        if (this.revision !== revision)
          throw Object.assign(new Error("Computer revision changed during prefetch"), {
            code: "ESTALE",
          });
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      signal?.throwIfAborted();
      if (this.revision !== revision)
        throw Object.assign(new Error("Computer revision changed during prefetch"), {
          code: "ESTALE",
        });
      this.#content.set(path, { bytes, release, pinned: 0 });
    } catch (cause) {
      release();
      throw cause;
    } finally {
      this.#prefetching.delete(path);
    }
  }

  pin(path: string) {
    this.assertCurrent();
    const content = this.#content.get(path);
    if (content === undefined) throw miss(path);
    content.pinned++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      content.pinned--;
    };
  }

  replaceContent(path: string, bytes: Uint8Array) {
    this.replaceWith(path, bytes.byteLength, (target) => target.set(bytes));
  }

  replaceWith(path: string, length: number, fill: (target: Uint8Array) => void) {
    this.assertCurrent();
    const previous = this.#content.get(path);
    const pinned = previous?.pinned ?? 0;
    // The old and replacement buffers coexist while a write is prepared.
    if (previous !== undefined) previous.pinned++;
    let release: (() => void) | undefined;
    try {
      this.#makeRoom(length);
      release = this.#budget.reserve(length);
      const owned = new Uint8Array(length);
      fill(owned);
      if (previous !== undefined) previous.release();
      if (previous === undefined) this.#content.set(path, { bytes: owned, release, pinned });
      else {
        previous.bytes = owned;
        previous.release = release;
      }
    } catch (cause) {
      release?.();
      throw cause;
    } finally {
      if (previous !== undefined) previous.pinned--;
    }
  }

  updateMetadata(entry: CliFileMetadata | { readonly path: string; readonly removed: true }) {
    this.assertCurrent();
    if ("removed" in entry) {
      this.#metadata.delete(entry.path);
      this.evict(entry.path);
      return;
    }
    if (!this.#metadata.has(entry.path) && this.#metadata.size >= this.#options.metadataLimit)
      throw new CliWorkingSetLimit(1, 0);
    if (
      !entry.path.startsWith("/") ||
      new TextEncoder().encode(entry.path).byteLength > this.#options.pathByteLimit
    )
      throw new TypeError("Invalid CLI metadata path");
    this.#metadata.set(entry.path, {
      ...entry,
      stat: {
        ...entry.stat,
        ...(entry.stat.posix === undefined ? {} : { posix: { ...entry.stat.posix } }),
      },
    });
  }

  invalidate() {
    this.#invalid = true;
    this.evictAll();
  }
  evict(path: string) {
    const content = this.#content.get(path);
    if (content === undefined) return;
    if (content.pinned > 0)
      throw Object.assign(new Error(`CLI file is in use: ${path}`), { code: "EBUSY" });
    this.#content.delete(path);
    content.release();
  }
  evictAll() {
    for (const content of this.#content.values()) {
      content.release();
      content.bytes = new Uint8Array(0);
    }
    this.#content.clear();
  }
  #makeRoom(size: number) {
    for (const [path, content] of this.#content) {
      if (size <= this.#options.byteLimit - this.bytes) return;
      if (content.pinned === 0) this.evict(path);
    }
    if (size > this.#options.byteLimit - this.bytes)
      throw new CliWorkingSetLimit(size, this.#options.byteLimit - this.bytes);
  }
  async close() {
    try {
      await this.writes.close();
    } finally {
      this.evictAll();
      this.#metadata.clear();
      this.#invalid = true;
    }
  }
}
