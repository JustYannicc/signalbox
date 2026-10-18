import { KernelWakeRegistry, type WakeSubscription } from "./KernelWakeRegistry.ts";

type Direction = "read" | "write";
type IoOptions = { nonblocking?: boolean; signal?: AbortSignal | undefined };

const pipeError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** One bounded pipe. Descriptor open descriptions own its two endpoints. */
export class KernelPipe {
  readonly #bytes: Uint8Array;
  readonly #wakes: KernelWakeRegistry;
  readonly #readers = new Set<() => void>();
  readonly #writers = new Set<() => void>();
  #start = 0;
  #length = 0;
  #readerClosed = false;
  #writerClosed = false;

  constructor(wakes: KernelWakeRegistry, capacity = 65_536) {
    if (!Number.isSafeInteger(capacity) || capacity < 4096 || capacity > 16_777_216) {
      throw new RangeError("Pipe capacity must be between 4096 and 16777216 bytes");
    }
    this.#wakes = wakes;
    this.#bytes = new Uint8Array(capacity);
  }

  get bufferedBytes() {
    return this.#length;
  }

  /** Hangup is readiness: the next read returns EOF or the next write reports EPIPE. */
  ready(direction: Direction) {
    return direction === "read"
      ? this.#length > 0 || this.#writerClosed || this.#readerClosed
      : this.#length < this.#bytes.length || this.#readerClosed || this.#writerClosed;
  }

  subscribe(direction: Direction): WakeSubscription {
    return (notify) => {
      const listeners = direction === "read" ? this.#readers : this.#writers;
      listeners.add(notify);
      return () => listeners.delete(notify);
    };
  }

  tryReadInto(target: Uint8Array): number {
    if (this.#readerClosed) throw pipeError("EBADF", "Pipe reader is closed");
    if (target.byteLength === 0) return 0;
    if (this.#length === 0) {
      if (this.#writerClosed) return 0;
      throw pipeError("EAGAIN", "Pipe has no readable bytes");
    }
    const count = Math.min(target.byteLength, this.#length);
    const first = Math.min(count, this.#bytes.length - this.#start);
    target.set(this.#bytes.subarray(this.#start, this.#start + first));
    target.set(this.#bytes.subarray(0, count - first), first);
    this.#start = (this.#start + count) % this.#bytes.length;
    this.#length -= count;
    this.#notify(this.#writers);
    return count;
  }

  tryWrite(source: Uint8Array): number {
    return this.#tryWrite(source, source.byteLength <= 4096);
  }

  #tryWrite(source: Uint8Array, atomic: boolean): number {
    if (this.#writerClosed) throw pipeError("EBADF", "Pipe writer is closed");
    if (source.byteLength === 0) return 0;
    if (this.#readerClosed) throw pipeError("EPIPE", "Pipe has no reader");
    const available = this.#bytes.length - this.#length;
    // POSIX PIPE_BUF writes must not interleave when writers share a pipe.
    if (available === 0 || (atomic && available < source.byteLength)) {
      throw pipeError("EAGAIN", "Pipe has insufficient write capacity");
    }
    const count = Math.min(source.byteLength, available);
    const end = (this.#start + this.#length) % this.#bytes.length;
    const first = Math.min(count, this.#bytes.length - end);
    this.#bytes.set(source.subarray(0, first), end);
    this.#bytes.set(source.subarray(first, count), 0);
    this.#length += count;
    this.#notify(this.#readers);
    return count;
  }

  readInto(target: Uint8Array, options: IoOptions = {}): Promise<number> {
    return this.#io("read", () => this.tryReadInto(target), options);
  }

  write(source: Uint8Array, options: IoOptions = {}): Promise<number> {
    // A blocked caller may grow or reuse guest memory before it resumes.
    const atomic = source.byteLength <= 4096;
    const owned = new Uint8Array(source.subarray(0, this.#bytes.length));
    return this.#io("write", () => this.#tryWrite(owned, atomic), options);
  }

  closeReader() {
    if (this.#readerClosed) return;
    this.#readerClosed = true;
    this.#length = 0;
    this.#notify(this.#readers);
    this.#notify(this.#writers);
  }

  closeWriter() {
    if (this.#writerClosed) return;
    this.#writerClosed = true;
    this.#notify(this.#readers);
    this.#notify(this.#writers);
  }

  async #io(direction: Direction, attempt: () => number, options: IoOptions) {
    for (;;) {
      if (options.signal?.aborted) throw pipeError("ECANCELED", "Pipe operation cancelled");
      if (options.nonblocking) return attempt();
      const registered = this.#wakes.register(this.subscribe(direction));
      if (registered.status !== "ok") {
        throw pipeError(
          registered.error.code === "RESOURCE_LIMIT" ? "ENOMEM" : "ECANCELED",
          registered.error.message,
        );
      }
      const token = registered.value;
      try {
        try {
          return attempt();
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
        }
        const notified = await this.#wakes.wait(token, options.signal);
        if (notified.status !== "ok") {
          throw pipeError(
            notified.error.code === "EXPIRED" ? "ETIMEDOUT" : "ECANCELED",
            notified.error.message,
          );
        }
      } finally {
        this.#wakes.release(token);
      }
    }
  }

  #notify(listeners: Set<() => void>) {
    // A callback can replace its subscription; only wake this event's listeners.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const notify of [...listeners]) notify();
  }
}
