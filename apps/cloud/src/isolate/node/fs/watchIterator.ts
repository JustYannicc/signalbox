// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Node watcher types and overflow warnings match the fs promises interface.
import type * as NodeFS from "node:fs";
import { NodeFsAbortError } from "./abort.ts";
import type { PathLike } from "./path.ts";
import {
  parseWatchIteratorOptions,
  type WatchEvent,
  type WatchIterator,
  type WatchFunction,
  type WatchOptions,
  type WatchListener,
  type WatchIteratorOptions,
  type ResolvedIteratorOptions,
} from "./watchOptions.ts";

interface IteratorWaiter {
  readonly resolve: (value: IteratorResult<WatchEvent>) => void;
  readonly reject: (reason: unknown) => void;
}

class WatchQueueOverflowError extends Error {
  readonly code = "ERR_FS_WATCH_QUEUE_OVERFLOW";

  constructor(maxQueue: number) {
    super(`The fs.promises.watch event queue exceeded its limit of ${maxQueue}`);
  }
}

class WatchEventIterator implements AsyncIterableIterator<WatchEvent> {
  #started = false;
  #closed = false;
  #error: { readonly reason: unknown; delivered: boolean } | undefined;
  #watcher: NodeFS.FSWatcher | undefined;
  #abortListener: (() => void) | undefined;
  #deliveryScheduled = false;
  #warnedOverflow = false;
  #queue: WatchEvent[] = [];
  #waiters: IteratorWaiter[] = [];

  readonly #watch: WatchFunction;
  readonly #path: PathLike;
  readonly #options: ResolvedIteratorOptions;

  constructor(watch: WatchFunction, path: PathLike, options: ResolvedIteratorOptions) {
    this.#watch = watch;
    this.#path = path;
    this.#options = options;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<WatchEvent> {
    return this;
  }

  next(): Promise<IteratorResult<WatchEvent>> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
    if (this.#error !== undefined) {
      if (this.#error.delivered) return Promise.resolve({ value: undefined, done: true });
      this.#error.delivered = true;
      this.#closed = true;
      this.#closeWatcher();
      return Promise.reject(this.#error.reason);
    }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });

    if (!this.#started) {
      this.#start();
      return this.next();
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
      this.#scheduleDelivery();
    });
  }

  return(value?: unknown): Promise<IteratorResult<WatchEvent>> {
    this.#finish();
    return Promise.resolve({ value, done: true });
  }

  throw(error?: unknown): Promise<IteratorResult<WatchEvent>> {
    this.#finish(error, true);
    return Promise.reject(error);
  }

  #start(): void {
    this.#started = true;
    const signal = this.#options.signal;
    if (signal?.aborted) {
      this.#fail(new NodeFsAbortError(signal.reason));
      return;
    }
    if (signal !== undefined) {
      this.#abortListener = () => this.#fail(new NodeFsAbortError(signal.reason));
      signal.addEventListener("abort", this.#abortListener, { once: true });
      if (signal.aborted) {
        this.#abortListener();
        return;
      }
    }

    const watchOptions: WatchOptions = {
      ...(this.#options.persistent === undefined ? {} : { persistent: this.#options.persistent }),
      ...(this.#options.recursive === undefined ? {} : { recursive: this.#options.recursive }),
      ...(this.#options.encoding === undefined ? {} : { encoding: this.#options.encoding }),
    };
    const listener: WatchListener = (eventType, filename) => {
      this.#push({ eventType, filename });
    };
    try {
      const watcher = this.#watch(this.#path, watchOptions, listener);
      this.#watcher = watcher;
      watcher.on("error", (error) => this.#fail(error));
      watcher.once("close", () => {
        if (!this.#closed && this.#error === undefined) this.#finish();
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  #push(event: WatchEvent): void {
    if (this.#closed || this.#error !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.#queue.length < this.#options.maxQueue) {
      this.#queue.push(event);
      return;
    }
    if (this.#options.overflow === "ignore") {
      if (!this.#warnedOverflow) {
        this.#warnedOverflow = true;
        globalThis.console?.warn("fs.promises.watch maxQueue exceeded");
      }
      return;
    }
    this.#queue = [];
    this.#fail(new WatchQueueOverflowError(this.#options.maxQueue));
  }

  #fail(reason: unknown): void {
    if (this.#closed || this.#error !== undefined) return;
    this.#error = { reason, delivered: false };
    this.#queue = [];
    this.#closeWatcher();
    this.#scheduleDelivery();
  }

  #finish(reason?: unknown, failed = false): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#closeWatcher();
    if (failed) {
      this.#error = { reason, delivered: true };
      for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
    } else {
      if (this.#error !== undefined) this.#error.delivered = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    }
  }

  #scheduleDelivery(): void {
    if (this.#deliveryScheduled) return;
    this.#deliveryScheduled = true;
    queueMicrotask(() => {
      this.#deliveryScheduled = false;
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift()!;
        const event = this.#queue.shift();
        if (event !== undefined) {
          waiter.resolve({ value: event, done: false });
          continue;
        }
        if (this.#error !== undefined && !this.#error.delivered) {
          this.#error.delivered = true;
          this.#closed = true;
          this.#closeWatcher();
          waiter.reject(this.#error.reason);
          continue;
        }
        if (this.#closed) {
          waiter.resolve({ value: undefined, done: true });
          continue;
        }
        this.#waiters.unshift(waiter);
        break;
      }
    });
  }

  #closeWatcher(): void {
    const signal = this.#options.signal;
    if (signal !== undefined && this.#abortListener !== undefined) {
      signal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = undefined;
    }
    this.#watcher?.close();
    this.#watcher = undefined;
  }
}

export function createWatchIterator(
  watch: WatchFunction,
  path: PathLike,
  options?: WatchIteratorOptions | BufferEncoding | "buffer",
): WatchIterator {
  return new WatchEventIterator(watch, path, parseWatchIteratorOptions(options));
}
