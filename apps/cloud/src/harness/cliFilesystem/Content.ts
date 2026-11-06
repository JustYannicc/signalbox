import { CliWorkingSetBudget } from "./Budget.ts";

interface Content {
  bytes: Uint8Array;
  release: () => void;
  pins: number;
}

export interface CliContentView {
  readonly size: number;
  copyInto(target: Uint8Array, offset: number): number;
  replace(length: number, fill: (target: Uint8Array) => void): void;
  refill(length: number, fill: (target: Uint8Array) => Promise<void>): Promise<void>;
  release(): void;
}

export function contentMiss(path: string) {
  return Object.assign(new Error(`Synchronous CLI file was not prefetched: ${path}`), {
    code: "CLI_FS_NOT_PREFETCHED",
    path,
  });
}

/** Names and open read views share one counted buffer, including detached, still-open inodes. */
export class CliContentStore {
  readonly #names = new Map<string, Content>();
  readonly #detached = new Set<Content>();
  readonly #budget;
  readonly #limit;
  constructor(budget: CliWorkingSetBudget, limit: number) {
    this.#budget = budget;
    this.#limit = limit;
  }
  get paths() {
    return [...this.#names.keys()];
  }
  has(path: string) {
    return this.#names.has(path);
  }
  reserve(size: number) {
    for (const [path, content] of this.#names) {
      if (size <= this.#limit - this.#budget.used) break;
      if (content.pins === 0) this.evict(path);
    }
    return this.#budget.reserve(size);
  }
  put(path: string, bytes: Uint8Array, release: () => void) {
    const old = this.#names.get(path);
    this.#names.set(path, { bytes, release, pins: 0 });
    if (old !== undefined) this.#retire(old);
  }
  #get(path: string) {
    const content = this.#names.get(path);
    if (content === undefined) throw contentMiss(path);
    this.#names.delete(path);
    this.#names.set(path, content);
    return content;
  }
  content(path: string) {
    return this.#get(path).bytes.slice();
  }
  #copy(content: Content, target: Uint8Array, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RangeError("Invalid CLI file offset");
    const count = Math.min(target.byteLength, Math.max(0, content.bytes.byteLength - offset));
    target.set(content.bytes.subarray(offset, offset + count));
    return count;
  }
  copyInto(path: string, target: Uint8Array, offset: number) {
    return this.#copy(this.#get(path), target, offset);
  }
  view(path: string): CliContentView {
    const content = this.#get(path);
    content.pins++;
    let active = true;
    return {
      get size() {
        return content.bytes.byteLength;
      },
      copyInto: (target, offset) => this.#copy(content, target, offset),
      replace: (length, fill) => this.#replace(content, length, fill),
      refill: async (length, fill) => {
        content.pins++;
        let release: (() => void) | undefined;
        try {
          release = this.reserve(length);
          const bytes = new Uint8Array(length);
          await fill(bytes);
          content.release();
          content.bytes = bytes;
          content.release = release;
        } catch (cause) {
          release?.();
          throw cause;
        } finally {
          content.pins--;
        }
      },
      release: () => {
        if (!active) return;
        active = false;
        content.pins--;
        this.#retire(content);
      },
    };
  }
  #replace(content: Content, length: number, fill: (target: Uint8Array) => void) {
    content.pins++;
    let release: (() => void) | undefined;
    try {
      release = this.reserve(length);
      const bytes = new Uint8Array(length);
      fill(bytes);
      content.release();
      content.bytes = bytes;
      content.release = release;
    } catch (cause) {
      release?.();
      throw cause;
    } finally {
      content.pins--;
    }
  }
  replace(path: string, length: number, fill: (target: Uint8Array) => void) {
    const content = this.#names.get(path);
    if (content !== undefined) return this.#replace(content, length, fill);
    const release = this.reserve(length);
    try {
      const bytes = new Uint8Array(length);
      fill(bytes);
      this.put(path, bytes, release);
    } catch (cause) {
      release();
      throw cause;
    }
  }
  project(removed: readonly string[], moves: readonly { from: string; to: string; copy?: true }[]) {
    if (removed.length === 0 && moves.length === 0) return;
    const previous = new Set(
      [...removed, ...moves.flatMap((move) => [move.from, move.to])].flatMap((path) => {
        const content = this.#names.get(path);
        return content === undefined ? [] : [content];
      }),
    );
    const moving = moves.map((move) => ({ ...move, content: this.#names.get(move.from) }));
    for (const path of removed) this.#names.delete(path);
    for (const move of moving) if (!move.copy) this.#names.delete(move.from);
    for (const move of moving) {
      this.#names.delete(move.to);
      if (move.content !== undefined) this.#names.set(move.to, move.content);
    }
    for (const content of previous) this.#retire(content);
  }
  #retire(content: Content) {
    if ([...this.#names.values()].includes(content)) return;
    if (content.pins > 0) {
      this.#detached.add(content);
      return;
    }
    this.#detached.delete(content);
    content.release();
    content.bytes = new Uint8Array(0);
  }
  evict(path: string) {
    const content = this.#names.get(path);
    if (content === undefined) return;
    if (content.pins > 0)
      throw Object.assign(new Error(`CLI file is in use: ${path}`), { code: "EBUSY" });
    this.#names.delete(path);
    this.#retire(content);
  }
  invalidate() {
    this.project(this.paths, []);
  }
  close() {
    const all = new Set([...this.#names.values(), ...this.#detached]);
    this.#names.clear();
    this.#detached.clear();
    for (const content of all) {
      content.release();
      content.bytes = new Uint8Array(0);
    }
  }
}
