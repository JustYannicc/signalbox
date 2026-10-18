import { RpcError } from "../CodexExecProtocol.ts";

export interface ProcessesInputOptions {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly pipeStdin: boolean;
  readonly maxWriteIds: number;
  readonly maxWriteBytes: number;
  readonly maxDedupBytes: number;
}

export class ProcessesInput {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pipeStdin: boolean;
  readonly #maxWriteIds: number;
  readonly #maxWriteBytes: number;
  readonly #maxDedupBytes: number;
  readonly #writeIds = new Map<string, Uint8Array>();
  #writeTail: Promise<void> = Promise.resolve();
  #retainedBytes = 0;
  #stdinClosed: boolean;
  #writerClosed = false;
  #disposing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ProcessesInputOptions) {
    this.#writer = options.writer;
    this.#pipeStdin = options.pipeStdin;
    this.#maxWriteIds = options.maxWriteIds;
    this.#maxWriteBytes = options.maxWriteBytes;
    this.#maxDedupBytes = options.maxDedupBytes;
    this.#stdinClosed = !options.pipeStdin;
    this.#writer.closed.then(
      () => this.#markWriterClosed(),
      () => this.#markWriterClosed(),
    );
  }

  get closed() {
    return this.#stdinClosed;
  }

  start() {
    if (!this.#pipeStdin) void this.close();
  }

  write(writeId: string, bytes: Uint8Array, signal: AbortSignal) {
    if (writeId.length === 0 || writeId.length > 256) {
      return Promise.reject(new RpcError(-32602, "writeId must contain 1 to 256 characters"));
    }
    if (bytes.byteLength > this.#maxWriteBytes) {
      return Promise.reject(new RpcError(-32602, "stdin chunk exceeds the write limit"));
    }
    if (bytes.byteLength > this.#maxDedupBytes) {
      return Promise.reject(
        new RpcError(-32602, "stdin chunk exceeds the write deduplication limit"),
      );
    }
    return this.#withWriteLock(async () => {
      if (signal.aborted) throw abortError();
      if (this.#disposing || this.#stdinClosed) return { status: "stdinClosed" };
      const previous = this.#writeIds.get(writeId);
      if (previous) {
        if (!bytesEqual(previous, bytes)) {
          throw new RpcError(-32600, "writeId was already used with different bytes");
        }
        return { status: "accepted" };
      }

      const ownedBytes = Uint8Array.from(bytes);
      try {
        await this.#writer.write(ownedBytes);
      } catch {
        this.#markWriterClosed();
        throw new RpcError(-32603, "Failed to write to process stdin");
      }
      this.#rememberWrite(writeId, ownedBytes);
      return { status: "accepted" };
    });
  }

  markExited() {
    this.#stdinClosed = true;
    void this.close();
  }

  async beginDispose() {
    this.#disposing = true;
    this.#stdinClosed = true;
    await this.#writeTail;
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    const closing = this.#withWriteLock(async () => {
      if (this.#writerClosed) return;
      this.#stdinClosed = true;
      this.#writerClosed = true;
      try {
        await this.#writer.close();
      } catch {
        this.#markWriterClosed();
      }
    });
    this.#closePromise = closing;
    try {
      await closing;
    } finally {
      this.#closePromise = undefined;
    }
  }

  release() {
    try {
      this.#writer.releaseLock();
    } catch {
      // A pending write still owns the writer; cleanup can be retried after it settles.
    }
  }

  #rememberWrite(writeId: string, bytes: Uint8Array) {
    const copy = Uint8Array.from(bytes);
    this.#writeIds.set(writeId, copy);
    this.#retainedBytes += copy.byteLength;
    while (this.#writeIds.size > this.#maxWriteIds || this.#retainedBytes > this.#maxDedupBytes) {
      const oldest = this.#writeIds.entries().next().value as [string, Uint8Array] | undefined;
      if (!oldest) break;
      this.#writeIds.delete(oldest[0]);
      this.#retainedBytes -= oldest[1].byteLength;
    }
  }

  #withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#writeTail;
    let release!: () => void;
    this.#writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(action).finally(release);
  }

  #markWriterClosed() {
    this.#stdinClosed = true;
    this.#writerClosed = true;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}
