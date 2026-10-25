// @effect-diagnostics nodeBuiltinImport:off - Implement Node's event interface over the virtual filesystem.
// @effect-diagnostics globalTimers:off - The virtual FS watcher uses a Node-compatible polling scheduler.
import * as NodeEvents from "node:events";
import type * as NodeFS from "node:fs";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { nodeFsError } from "./errors.ts";
import { encodedPath } from "./metadata.ts";
import { pathString, type PathLike } from "./path.ts";
import {
  diffWatchSnapshots,
  takeWatchSnapshot,
  takeWatchSnapshotAllowMissing,
  type Snapshot,
} from "./watchSnapshot.ts";
import { parseWatchOptions, type RegisterCleanup, type WatchFunction } from "./watchOptions.ts";

// Storage has no change feed, so polling can coalesce mutations between samples.
const DEFAULT_POLL_INTERVAL_MS = 100;

type RefableTimer = { ref?: () => unknown; unref?: () => unknown };

function setTimerReference(timer: ReturnType<typeof setInterval>, referenced: boolean): void {
  if (typeof timer !== "object" || timer === null) return;
  const method = referenced ? "ref" : "unref";
  const reference = (timer as RefableTimer)[method];
  if (typeof reference === "function") reference.call(timer);
}

/** The generation is read before its snapshot, so a write in between only costs a rescan. */
interface Baseline {
  readonly generation: number | undefined;
  readonly snapshot: Snapshot;
}

class PollingFSWatcher extends NodeEvents.EventEmitter {
  #closed = false;
  #referenced: boolean;
  #timer: ReturnType<typeof setInterval> | undefined;
  #removeCleanup: (() => void) | undefined;
  #abortListener: (() => void) | undefined;

  readonly #kernelFs: KernelFileSystem;
  readonly #path: string;
  readonly #displayPath: string;
  readonly #options: ReturnType<typeof parseWatchOptions>["options"];
  #baseline: Baseline;
  readonly #registerCleanup: RegisterCleanup;

  constructor(
    kernelFs: KernelFileSystem,
    path: string,
    displayPath: string,
    options: ReturnType<typeof parseWatchOptions>["options"],
    baseline: Baseline,
    registerCleanup: RegisterCleanup,
  ) {
    super();
    this.#kernelFs = kernelFs;
    this.#path = path;
    this.#displayPath = displayPath;
    this.#options = options;
    this.#baseline = baseline;
    this.#registerCleanup = registerCleanup;
    this.#referenced = options.persistent;
  }

  start(): void {
    this.#removeCleanup = this.#registerCleanup(() => this.close());
    const signal = this.#options.signal;
    if (signal !== undefined) {
      this.#abortListener = () => this.close();
      signal.addEventListener("abort", this.#abortListener, { once: true });
      if (signal.aborted) this.close();
    }
    if (this.#closed) return;
    this.#timer = setInterval(() => this.#poll(), DEFAULT_POLL_INTERVAL_MS);
    setTimerReference(this.#timer, this.#referenced);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const signal = this.#options.signal;
    if (signal !== undefined && this.#abortListener !== undefined) {
      signal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = undefined;
    }
    this.#removeCleanup?.();
    this.#removeCleanup = undefined;
    queueMicrotask(() => this.emit("close"));
  }

  ref(): this {
    this.#referenced = true;
    if (this.#timer !== undefined) setTimerReference(this.#timer, true);
    return this;
  }

  unref(): this {
    this.#referenced = false;
    if (this.#timer !== undefined) setTimerReference(this.#timer, false);
    return this;
  }

  #poll(): void {
    if (this.#closed) return;
    let next: Baseline;
    try {
      // Rescanning every watched tree each tick costs a path walk and stat per entry; skip it while
      // nothing has committed.
      const generation = this.#kernelFs.changeGeneration();
      if (
        generation !== undefined &&
        generation === this.#baseline.generation &&
        !this.#baseline.snapshot.descriptorDependent
      )
        return;
      next = {
        generation,
        snapshot: takeWatchSnapshotAllowMissing(
          this.#kernelFs,
          this.#path,
          this.#options.recursive,
        ),
      };
    } catch (cause) {
      const error = nodeFsError(cause, "watch", this.#displayPath) as Error;
      this.close();
      this.emit("error", error);
      return;
    }

    const changes = diffWatchSnapshots(this.#baseline.snapshot, next.snapshot, this.#path);
    this.#baseline = next;
    for (const change of changes) {
      if (this.#closed) return;
      this.emit("change", change.eventType, encodedPath(change.filename, this.#options.encoding));
    }
  }
}

export function createWatchEvents(
  kernelFs: KernelFileSystem,
  registerCleanup: RegisterCleanup,
): {
  readonly watch: WatchFunction;
} {
  const watch: WatchFunction = (
    path: PathLike,
    options?: BufferEncoding | "buffer" | Parameters<typeof parseWatchOptions>[0],
    listener?: Parameters<typeof parseWatchOptions>[1],
  ) => {
    const parsed = parseWatchOptions(options, listener);
    const rawPath = pathString(path);
    let absolutePath: string;
    let baseline: Baseline;
    try {
      absolutePath = kernelFs.realpath(rawPath);
      const generation = kernelFs.changeGeneration();
      baseline = {
        generation,
        snapshot: takeWatchSnapshot(kernelFs, absolutePath, parsed.options.recursive),
      };
    } catch (cause) {
      throw nodeFsError(cause, "watch", rawPath);
    }
    const watcher = new PollingFSWatcher(
      kernelFs,
      absolutePath,
      rawPath,
      parsed.options,
      baseline,
      registerCleanup,
    );
    if (parsed.listener !== undefined) watcher.on("change", parsed.listener);
    watcher.start();
    return watcher as unknown as NodeFS.FSWatcher;
  };

  return {
    watch,
  };
}
