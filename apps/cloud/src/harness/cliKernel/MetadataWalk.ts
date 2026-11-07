import type {
  KernelFileSystem,
  KernelFileSystemTree,
  KernelStat,
  KernelTreeEntry,
} from "../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../CliFileWorkingSet.ts";
import type { ClaudeCliMetadataPage } from "../ClaudeCliKernelPort.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import { turnBudget } from "../cliFilesystem/Turn.ts";
import { nodeFsError } from "../../isolate/NodeFsError.ts";

interface Walk {
  readonly entries: readonly CliFileMetadata[];
  readonly done: boolean;
  next(count: number, signal: AbortSignal): Promise<void>;
}

/**
 * One index handed out a page at a time: the entries read so far, and the walk that reads on when
 * the CLI asks past them. Pages are read one at a time, and each is traced as it starts and ends.
 */
export class CliMetadataIndex {
  readonly revision: number;
  readonly #walk: Walk;
  readonly #trace: (event: CliViewTrace) => void;
  #reading: Promise<unknown> = Promise.resolve();
  #failed = false;

  constructor(revision: number, walk: Walk, trace: (event: CliViewTrace) => void) {
    this.revision = revision;
    this.#walk = walk;
    this.#trace = trace;
  }

  /** The walk failed and can't go on; a new index has to start over. */
  get failed() {
    return this.#failed;
  }

  async page(cursor: number, size: number, signal: AbortSignal): Promise<ClaudeCliMetadataPage> {
    const entries = this.#walk.entries;
    if (this.#failed || cursor > entries.length) throw kernelError("ESTALE");
    const end = cursor + size;
    const read = this.#reading.then(() => this.#readTo(end, signal));
    this.#reading = read.catch(() => undefined);
    await read;
    const last = Math.min(entries.length, end);
    return {
      revision: this.revision,
      entries: entries.slice(cursor, last),
      next: this.#walk.done && last === entries.length ? null : last,
    };
  }

  async #readTo(end: number, signal: AbortSignal) {
    const before = this.#walk.entries.length;
    if (before >= end || this.#walk.done) return;
    const started = performance.now();
    const trace = (phase: "start" | "end", failed?: true) => {
      try {
        this.#trace({
          kind: "index-page",
          phase,
          cursor: before,
          entries: this.#walk.entries.length - before,
          ...(phase === "end" ? { durationMs: Math.round(performance.now() - started) } : {}),
          ...(failed === undefined ? {} : { failed }),
        });
      } catch {
        /* A lost trace is only a missing diagnostic. */
      }
    };
    trace("start");
    try {
      await this.#walk.next(end - before, signal);
    } catch (cause) {
      this.#failed = true;
      trace("end", true);
      throw cause;
    }
    trace("end");
  }
}

interface Entry {
  readonly path: string;
  readonly stat: KernelStat;
}

/** How the walk reads the tree: by inode, or path by path where it can't. */
interface TreeSource<E extends Entry> {
  /**
   * Whether the walk may stop between pages. Read path by path, a directory can turn out
   * unsearchable after the walk handed it out, and is then marked with its denial where it
   * stands, so only a snapshot, which can't change, is read a page per call.
   */
  readonly paged: boolean;
  run<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T>;
  root(signal: AbortSignal): Promise<E>;
  readdir(directory: E, signal: AbortSignal): Promise<readonly string[]>;
  lstat(directory: E, name: string, signal: AbortSignal): Promise<E>;
  readlink(entry: E, signal: AbortSignal): Promise<string>;
}

interface Frame<E extends Entry> {
  readonly directory: E;
  readonly names: readonly string[];
  /** Where the directory's own entry is, to mark a denial its later children reveal. */
  readonly at: number;
  next: number;
  /** The child read to learn whether the directory is searchable, visited first. */
  first: E | undefined;
}

/**
 * The CLI's index of accessible metadata, depth first, read on as far as asked. Indexing is
 * unsolicited: a directory the CLI may not read or search is kept with its denial for actual CLI
 * access, never turned into a failure.
 */
export class CliMetadataWalk<E extends Entry> {
  readonly entries: CliFileMetadata[] = [];
  readonly #source: TreeSource<E>;
  readonly #limit: number;
  readonly #stack: Frame<E>[] = [];
  #started = false;

  constructor(source: TreeSource<E>, limit: number) {
    this.#source = source;
    this.#limit = limit;
  }

  get done() {
    return this.#started && this.#stack.length === 0;
  }

  /** Reads at least `count` more entries, or to the end; a live source reads to the end. */
  async next(count: number, signal: AbortSignal): Promise<void> {
    if (this.done) return;
    const source = this.#source;
    const until = source.paged ? this.entries.length + count : Infinity;
    await source.run(signal, async () => {
      const turn = turnBudget();
      if (!this.#started) {
        let root;
        try {
          root = await source.root(signal);
        } catch (cause) {
          throw nodeFsError(cause, "lstat", "/");
        }
        this.#started = true;
        await this.#enter(root, signal);
      }
      while (this.entries.length < until) {
        signal.throwIfAborted();
        const frame = this.#stack.at(-1);
        if (frame === undefined) break;
        let child = frame.first;
        frame.first = undefined;
        if (child === undefined) {
          const name = frame.names[frame.next++];
          if (name === undefined) {
            this.#stack.pop();
            continue;
          }
          await turn();
          const path = childPath(frame.directory.path, name);
          try {
            child = await source.lstat(frame.directory, name, signal);
          } catch (cause) {
            if (vanished(path, cause)) continue;
            if (!denied(cause)) throw nodeFsError(cause, "lstat", path);
            // Its first child showed it searchable, so it changed since; the rest stay unread.
            this.#stack.pop();
            this.#denySearch(frame);
            continue;
          }
        }
        await this.#enter(child, signal);
      }
    });
  }

  /** Adds one entry, with any denial already decided, and queues a directory's children. */
  async #enter(entry: E, signal: AbortSignal) {
    if (this.entries.length >= this.#limit) throw kernelError("E2BIG");
    const { path, stat } = entry;
    let target: string | undefined;
    if (stat.type === "symlink") {
      try {
        target = await this.#source.readlink(entry, signal);
      } catch (cause) {
        if (vanished(path, cause)) return;
        throw nodeFsError(cause, "readlink", path);
      }
    }
    const metadata: CliFileMetadata = { path, stat, ...(target === undefined ? {} : { target }) };
    if (stat.type !== "directory") return void this.entries.push(metadata);
    let names: readonly string[];
    try {
      names = await this.#source.readdir(entry, signal);
    } catch (cause) {
      if (vanished(path, cause)) return;
      if (!denied(cause)) throw nodeFsError(cause, "scandir", path);
      return void this.entries.push({ ...metadata, directoryDenial: { read: "EACCES" } });
    }
    const at = this.entries.push(metadata) - 1;
    const frame: Frame<E> = { directory: entry, names, at, next: 0, first: undefined };
    while (frame.first === undefined) {
      const name = names[frame.next++];
      if (name === undefined) return;
      const child = childPath(path, name);
      try {
        frame.first = await this.#source.lstat(entry, name, signal);
      } catch (cause) {
        if (vanished(child, cause)) continue;
        if (!denied(cause)) throw nodeFsError(cause, "lstat", child);
        return this.#denySearch(frame);
      }
    }
    this.#stack.push(frame);
  }

  #denySearch(frame: Frame<E>) {
    this.entries[frame.at] = {
      ...this.entries[frame.at]!,
      children: [...frame.names],
      directoryDenial: { search: "EACCES" },
    };
  }
}

/**
 * The walk for a filesystem: from one storage snapshot where it can be, path by path where not. A
 * snapshot holds every name of Computer's storage; twice the index's own bound leaves room for
 * names it never reaches, and a larger tree is read path by path, which counts only those.
 */
export function createCliMetadataWalk(filesystem: KernelFileSystem, limit: number) {
  const tree = filesystem.metadataTree(limit * 2);
  return tree === undefined
    ? new CliMetadataWalk(pathSource(filesystem), limit)
    : new CliMetadataWalk(treeSource(tree), limit);
}

function treeSource(tree: KernelFileSystemTree): TreeSource<KernelTreeEntry> {
  return {
    paged: true,
    run: (signal, run) => tree.run(signal, run),
    root: () => tree.root(),
    readdir: (directory) => tree.readdir(directory),
    lstat: (directory, name) => tree.lstat(directory, name),
    readlink: (entry) => tree.readlink(entry),
  };
}

function pathSource(filesystem: KernelFileSystem): TreeSource<Entry> {
  return {
    paged: false,
    run: (_signal, run) => run(),
    root: async (signal) => ({ path: "/", stat: await filesystem.lstatAsync("/", signal) }),
    readdir: (directory, signal) => filesystem.readdirAsync(directory.path, signal),
    async lstat(directory, name, signal) {
      const path = childPath(directory.path, name);
      return { path, stat: await filesystem.lstatAsync(path, signal) };
    },
    readlink: async (entry) => filesystem.readlink(entry.path),
  };
}

const childPath = (parent: string, name: string) => `${parent === "/" ? "" : parent}/${name}`;

// Read live, a child can go between its directory's listing and its own lstat. A gone child is
// left out; the change feed brings it to the next round.
const vanished = (path: string, cause: unknown) =>
  path !== "/" && ["ENOENT", "ENOTDIR"].includes(code(cause));

const denied = (cause: unknown) => code(cause) === "EACCES";

const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
