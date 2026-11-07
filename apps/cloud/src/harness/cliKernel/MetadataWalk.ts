import type { KernelFileSystem, KernelStat } from "../../kernel/KernelFileSystem.ts";
import type { CliFileMetadata } from "../CliFileWorkingSet.ts";
import type { ClaudeCliMetadataPage } from "../ClaudeCliKernelPort.ts";
import type { CliViewTrace } from "../CliViewTrace.ts";
import { kernelError } from "../../kernel/KernelErrno.ts";
import { turnBudget } from "../cliFilesystem/Turn.ts";
import { nodeFsError } from "../../isolate/NodeFsError.ts";

/**
 * One index handed out a page at a time: the entries read so far, and the walk that reads on when
 * the CLI asks past them. Pages are read one at a time, and each is traced as it starts and ends.
 */
export class CliMetadataIndex {
  readonly revision: number;
  readonly #walk: CliMetadataWalk;
  readonly #trace: (event: CliViewTrace) => void;
  readonly #entries: CliFileMetadata[] = [];
  #reading: Promise<unknown> = Promise.resolve();
  #failed = false;

  constructor(revision: number, walk: CliMetadataWalk, trace: (event: CliViewTrace) => void) {
    this.revision = revision;
    this.#walk = walk;
    this.#trace = trace;
  }

  /** The walk failed and can't go on; a new index has to start over. */
  get failed() {
    return this.#failed;
  }

  async page(cursor: number, size: number, signal: AbortSignal): Promise<ClaudeCliMetadataPage> {
    if (this.#failed || cursor > this.#entries.length) throw kernelError("ESTALE");
    const end = cursor + size;
    const read = this.#reading.then(() => this.#readTo(end, signal));
    this.#reading = read.catch(() => undefined);
    await read;
    const last = Math.min(this.#entries.length, end);
    return {
      revision: this.revision,
      entries: this.#entries.slice(cursor, last),
      next: this.#walk.done && last === this.#entries.length ? null : last,
    };
  }

  async #readTo(end: number, signal: AbortSignal) {
    const before = this.#entries.length;
    if (before >= end || this.#walk.done) return;
    const started = performance.now();
    const trace = (phase: "start" | "end", failed?: true) => {
      try {
        this.#trace({
          kind: "index-page",
          phase,
          cursor: before,
          entries: this.#entries.length - before,
          ...(phase === "end" ? { durationMs: Math.round(performance.now() - started) } : {}),
          ...(failed === undefined ? {} : { failed }),
        });
      } catch {
        /* A lost trace is only a missing diagnostic. */
      }
    };
    trace("start");
    try {
      this.#entries.push(...(await this.#walk.next(end - before, signal)));
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

/** How the walk reads the tree: from one storage snapshot, or path by path where there is none. */
interface TreeSource {
  run<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T>;
  root(signal: AbortSignal): Promise<Entry>;
  readdir(directory: Entry, signal: AbortSignal): Promise<readonly string[]>;
  lstat(directory: Entry, name: string, signal: AbortSignal): Promise<Entry>;
  readlink(entry: Entry, signal: AbortSignal): Promise<string>;
}

interface Frame {
  readonly directory: Entry;
  readonly names: readonly string[];
  next: number;
  /** The child read to learn whether the directory is searchable, visited first. */
  first: Entry | undefined;
}

/**
 * The CLI's index of accessible metadata, depth first, a page at a time, so no single call to
 * Computer walks the whole tree. Indexing is unsolicited: a directory the CLI may not read or
 * search is kept with its denial for actual CLI access, never turned into a failure.
 */
export class CliMetadataWalk {
  readonly #filesystem: KernelFileSystem;
  readonly #limit: number;
  #source: TreeSource | undefined;
  readonly #stack: Frame[] = [];
  #started = false;
  #produced = 0;

  constructor(filesystem: KernelFileSystem, limit: number) {
    this.#filesystem = filesystem;
    this.#limit = limit;
  }

  get done() {
    return this.#started && this.#stack.length === 0;
  }

  /** Up to `count` more entries; fewer only at the end. */
  async next(count: number, signal: AbortSignal): Promise<CliFileMetadata[]> {
    if (this.done) return [];
    const source = (this.#source ??= treeSource(this.#filesystem, this.#limit));
    const page: CliFileMetadata[] = [];
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
        await this.#enter(source, root, page, signal);
      }
      while (page.length < count) {
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
            // Its first child already showed the directory searchable; only a change since can
            // deny the rest, and the directory itself was already handed out.
            if (denied(cause)) {
              this.#stack.pop();
              continue;
            }
            throw nodeFsError(cause, "lstat", path);
          }
        }
        await this.#enter(source, child, page, signal);
      }
    });
    if (this.done) this.#source = undefined;
    return page;
  }

  /** Emits one entry, with any denial already decided, and queues a directory's children. */
  async #enter(source: TreeSource, entry: Entry, page: CliFileMetadata[], signal: AbortSignal) {
    if (this.#produced >= this.#limit) throw kernelError("E2BIG");
    const emit = (metadata: CliFileMetadata) => {
      this.#produced++;
      page.push(metadata);
    };
    const { path, stat } = entry;
    let target: string | undefined;
    if (stat.type === "symlink") {
      try {
        target = await source.readlink(entry, signal);
      } catch (cause) {
        if (vanished(path, cause)) return;
        throw nodeFsError(cause, "readlink", path);
      }
    }
    const metadata: CliFileMetadata = { path, stat, ...(target === undefined ? {} : { target }) };
    if (stat.type !== "directory") return emit(metadata);
    let names: readonly string[];
    try {
      names = await source.readdir(entry, signal);
    } catch (cause) {
      if (vanished(path, cause)) return;
      if (!denied(cause)) throw nodeFsError(cause, "scandir", path);
      return emit({ ...metadata, directoryDenial: { read: "EACCES" } });
    }
    const frame: Frame = { directory: entry, names, next: 0, first: undefined };
    while (frame.first === undefined) {
      const name = names[frame.next++];
      if (name === undefined) break;
      const child = childPath(path, name);
      try {
        frame.first = await source.lstat(entry, name, signal);
      } catch (cause) {
        if (vanished(child, cause)) continue;
        if (!denied(cause)) throw nodeFsError(cause, "lstat", child);
        return emit({ ...metadata, children: [...names], directoryDenial: { search: "EACCES" } });
      }
    }
    emit(metadata);
    if (frame.first !== undefined) this.#stack.push(frame);
  }
}

/**
 * A snapshot holds every name of Computer's storage. Names are almost all visible ones, which the
 * index already bounds, so twice that is room for the few hidden below a denied directory.
 */
function treeSource(filesystem: KernelFileSystem, limit: number): TreeSource {
  let tree;
  try {
    tree = filesystem.metadataTree(limit * 2);
  } catch (cause) {
    if (code(cause) === "E2BIG") throw kernelError("E2BIG");
    throw cause;
  }
  if (tree !== undefined) return tree;
  return {
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

// Read path by path, or live from the machine, a child can go between its directory's listing and
// its own lstat. A gone child is left out; the change feed brings it to the next round.
const vanished = (path: string, cause: unknown) =>
  path !== "/" && ["ENOENT", "ENOTDIR"].includes(code(cause));

const denied = (cause: unknown) => code(cause) === "EACCES";

const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
