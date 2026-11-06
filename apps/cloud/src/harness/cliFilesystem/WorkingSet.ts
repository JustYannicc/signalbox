import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../../kernel/KernelSyscallPort.ts";
import type { KernelStat } from "../../kernel/KernelFileSystem.ts";
import { CliWorkingSetBudget, CliWorkingSetLimit } from "./Budget.ts";
import { CliWriteBarrier } from "./WriteBarrier.ts";
import { CliContentStore, contentMiss } from "./Content.ts";

export interface CliFileMetadata {
  readonly path: string;
  readonly stat: KernelStat;
  readonly target?: string;
  readonly directoryDenial?: { readonly read?: "EACCES"; readonly search?: "EACCES" };
  /** Indexing was denied here before a later permission change; what it could not see stays unknown. */
  readonly unindexed?: true;
  readonly children?: readonly string[];
  /** Computer assigns inode identity when the queued creation commits. */
  readonly pending?: true;
}

/** The indexer's denial described the old owner and mode; once they change, the path check decides. */
export function withStat(entry: CliFileMetadata, stat: KernelStat): CliFileMetadata {
  const { directoryDenial, ...rest } = entry;
  const before = entry.stat.posix;
  const after = stat.posix;
  const permissionsChanged =
    before?.mode !== after?.mode || before?.uid !== after?.uid || before?.gid !== after?.gid;
  if (directoryDenial === undefined || !permissionsChanged) return { ...entry, stat };
  return { ...rest, stat, unindexed: true };
}

export interface CliFileWorkingSetOptions {
  readonly byteLimit: number;
  readonly metadataLimit: number;
  readonly pathByteLimit: number;
}

/** A revision-bound read view. It owns no filesystem, descriptor allocator or storage engine. */
export class CliFileWorkingSet {
  readonly #budget;
  readonly writes;
  readonly #metadata = new Map<string, CliFileMetadata>();
  readonly #content;
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
    this.#content = new CliContentStore(this.#budget, options.byteLimit);
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
    return this.#content.paths;
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
    if (this.#revision !== revision) this.#content.invalidate();
    this.#metadata.clear();
    for (const [path, entry] of metadata) this.#metadata.set(path, entry);
    this.#revision = revision;
    this.#invalid = false;
  }

  metadata(path: string) {
    this.assertCurrent();
    const entry = this.#metadata.get(path);
    if (entry === undefined) {
      const slash = path.lastIndexOf("/");
      const parent = this.#metadata.get(path.slice(0, slash) || "/");
      // A name the denied index never saw may exist; only a listed directory can prove absence.
      if (parent?.unindexed && parent.children?.includes(path.slice(slash + 1)) !== false)
        throw contentMiss(path);
      throw Object.assign(new Error(`No such file: ${path}`), { code: "ENOENT" });
    }
    return {
      ...entry,
      stat: {
        ...entry.stat,
        ...(entry.stat.posix === undefined ? {} : { posix: { ...entry.stat.posix } }),
      },
    };
  }

  children(path: string) {
    const entry = this.metadata(path);
    if (entry.directoryDenial?.read !== undefined)
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    if (entry.unindexed && entry.children === undefined) throw contentMiss(path);
    if (entry.stat.type !== "directory")
      throw Object.assign(new Error(`Not a directory: ${path}`), { code: "ENOTDIR" });
    const prefix = path === "/" ? "/" : `${path}/`;
    const indexed = [...this.#metadata.keys()].flatMap((name) => {
      if (!name.startsWith(prefix)) return [];
      const child = name.slice(prefix.length);
      return child !== "" && !child.includes("/") ? [child] : [];
    });
    // A search-denied listing keeps names whose entries were never indexed, plus later creates.
    return entry.children === undefined ? indexed : [...new Set([...entry.children, ...indexed])];
  }

  content(path: string) {
    this.assertCurrent();
    return this.#content.content(path);
  }
  copyInto(path: string, target: Uint8Array, offset: number) {
    this.assertCurrent();
    return this.#content.copyInto(path, target, offset);
  }
  view(path: string) {
    this.assertCurrent();
    return this.#content.view(path);
  }
  hasContent(path: string) {
    this.assertCurrent();
    return this.#content.has(path);
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
    const release = this.#content.reserve(size);
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
      this.#content.put(path, bytes, release);
    } catch (cause) {
      release();
      throw cause;
    } finally {
      this.#prefetching.delete(path);
    }
  }

  pin(path: string) {
    return this.view(path).release;
  }
  replaceContent(path: string, bytes: Uint8Array) {
    this.replaceWith(path, bytes.byteLength, (target) => target.set(bytes));
  }
  replaceWith(path: string, length: number, fill: (target: Uint8Array) => void) {
    this.assertCurrent();
    this.#content.replace(path, length, fill);
  }
  project(
    updates: readonly (CliFileMetadata | { readonly path: string; readonly removed: true })[],
    moves: readonly { from: string; to: string; copy?: true }[] = [],
  ) {
    this.assertCurrent();
    const next = new Map(this.#metadata);
    const removed: string[] = [];
    for (const entry of updates) {
      if ("removed" in entry) {
        next.delete(entry.path);
        removed.push(entry.path);
      } else
        next.set(entry.path, {
          ...entry,
          stat: {
            ...entry.stat,
            ...(entry.stat.posix === undefined ? {} : { posix: { ...entry.stat.posix } }),
          },
        });
    }
    if (next.size > this.#options.metadataLimit)
      throw new CliWorkingSetLimit(next.size, this.#options.metadataLimit);
    for (const path of next.keys())
      if (
        !path.startsWith("/") ||
        new TextEncoder().encode(path).byteLength > this.#options.pathByteLimit
      )
        throw new TypeError("Invalid CLI metadata path");
    return () => {
      this.#content.project(removed, moves);
      this.#metadata.clear();
      for (const [path, entry] of next) this.#metadata.set(path, entry);
    };
  }
  updateMetadata(entry: CliFileMetadata | { readonly path: string; readonly removed: true }) {
    this.project([entry])();
  }
  invalidate() {
    this.#invalid = true;
  }
  evict(path: string) {
    this.#content.evict(path);
  }
  evictAll() {
    this.#content.invalidate();
  }
  async close() {
    try {
      await this.writes.close();
    } finally {
      this.#content.close();
      this.#metadata.clear();
      this.#invalid = true;
    }
  }
}
