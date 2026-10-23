import { KernelWakeRegistry, type WakeSubscription } from "./KernelWakeRegistry.ts";

type Direction = "read" | "write";
type IoOptions = { nonblocking?: boolean; signal?: AbortSignal | undefined };

const pipeError = (code: string, message: string) => Object.assign(new Error(message), { code });
const PIPE_BUF_BYTES = 4096;
const MAX_BLOCKING_WRITE_BYTES = 16 * 1024 * 1024;
// Blocked writers keep their payload until readers drain it, and every pipe shares the isolate's
// memory, so their payloads together stay under one budget. Past it, writers fall back to a short
// write of at most one pipe buffer, which they retry.
const RETAINED_WRITE_BYTES = 16 * 1024 * 1024;
let retainedWriteBytes = 0;

/** Distinguishes a missing pipe reader from an unrelated backend or host EPIPE. */
export class KernelBrokenPipeError extends Error {
  readonly code = "EPIPE";
  readonly bytesWritten: number;

  constructor(bytesWritten = 0) {
    super("Pipe has no reader");
    this.name = "KernelBrokenPipeError";
    this.bytesWritten = bytesWritten;
  }
}

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
    return this.#tryWrite(source, source.byteLength <= PIPE_BUF_BYTES);
  }

  #tryWrite(source: Uint8Array, atomic: boolean): number {
    if (this.#writerClosed) throw pipeError("EBADF", "Pipe writer is closed");
    if (source.byteLength === 0) return 0;
    if (this.#readerClosed) throw new KernelBrokenPipeError();
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
    const atomic = source.byteLength <= PIPE_BUF_BYTES;
    const owned = new Uint8Array(source.subarray(0, this.#bytes.length));
    return this.#io("write", () => this.#tryWrite(owned, atomic), options);
  }

  async writeBlocking(
    source: Uint8Array,
    options: Pick<IoOptions, "signal"> = {},
  ): Promise<number> {
    // WASI caps vectors here too; larger Node callers receive a bounded short write.
    const size = Math.min(
      source.byteLength,
      MAX_BLOCKING_WRITE_BYTES,
      RETAINED_WRITE_BYTES - retainedWriteBytes,
    );
    if (size < Math.min(source.byteLength, this.#bytes.length)) return this.write(source, options);
    retainedWriteBytes += size;
    const owned = new Uint8Array(source.subarray(0, size));
    const atomic = source.byteLength <= PIPE_BUF_BYTES;
    let offset = 0;
    try {
      return await this.#io(
        "write",
        () => {
          if (owned.byteLength === 0) return this.#tryWrite(owned, atomic);
          while (offset < owned.byteLength) {
            try {
              offset += this.#tryWrite(owned.subarray(offset), atomic);
            } catch (error) {
              if (error instanceof KernelBrokenPipeError) {
                throw new KernelBrokenPipeError(offset + error.bytesWritten);
              }
              throw error;
            }
          }
          return offset;
        },
        options,
      );
    } catch (error) {
      // A retry must not duplicate a prefix that already reached the reader.
      if (
        offset > 0 &&
        error instanceof Error &&
        "code" in error &&
        ["ECANCELED", "EBADF", "ENOMEM"].includes(String(error.code))
      ) {
        return offset;
      }
      throw error;
    } finally {
      retainedWriteBytes -= size;
    }
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
          // Notification expiry is not a deadline for the blocking pipe operation.
          if (notified.error.code === "EXPIRED") continue;
          throw pipeError("ECANCELED", notified.error.message);
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
