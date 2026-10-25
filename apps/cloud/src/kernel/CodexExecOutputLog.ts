// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - portable byte replay and requested long-poll deadlines run outside Effect.
import * as NodeBuffer from "node:buffer";

export type OutputStream = "stdout" | "stderr" | "pty";

export interface OutputLogChunk {
  readonly seq: number;
  readonly stream: OutputStream;
  readonly chunk: string;
}

export interface OutputLogOptions {
  readonly maxBytes?: number;
  readonly maxChunks?: number;
  readonly maxChunkBytes?: number;
}

export interface OutputLogReadOptions {
  readonly afterSeq?: number;
  readonly maxBytes?: number;
  readonly waitMs?: number;
}

export interface OutputLogRead {
  readonly chunks: readonly OutputLogChunk[];
  readonly nextSeq: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly closed: boolean;
  readonly failure: null;
  readonly sandboxDenied: false;
}

interface RetainedChunk {
  readonly bytes: Uint8Array;
  readonly stream: OutputStream;
}

type WakeResult = "changed" | "timeout" | "aborted" | "cancelled";

interface Waiter {
  readonly promise: Promise<WakeResult>;
  readonly cancel: () => void;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_CHUNKS = 50_000;
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function limit(value: number | undefined, fallback: number, name: string, allowZero = true) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw new RangeError(
      `${name} must be a ${allowZero ? "nonnegative" : "positive"} safe integer`,
    );
  }
  return result;
}

function abortError(message = "The operation was aborted") {
  return new DOMException(message, "AbortError");
}

/** In-memory, bounded replay of one exec-server process's output and terminal events. */
export class CodexExecOutputLog {
  readonly #maxBytes: number;
  readonly #maxChunks: number;
  readonly #maxChunkBytes: number;
  readonly #chunks = new Map<number, RetainedChunk>();
  readonly #waiters = new Set<() => void>();
  #retainedBytes = 0;
  #nextSeq = 1;
  #exitEvent: { readonly seq: number; readonly exitCode: number } | undefined;
  #closeEvent: { readonly seq: number } | undefined;
  #disposed = false;

  constructor(options: OutputLogOptions = {}) {
    this.#maxBytes = limit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
    this.#maxChunks = limit(options.maxChunks, DEFAULT_MAX_CHUNKS, "maxChunks");
    this.#maxChunkBytes = limit(
      options.maxChunkBytes,
      DEFAULT_MAX_CHUNK_BYTES,
      "maxChunkBytes",
      /* allowZero */ false,
    );
  }

  append(stream: OutputStream, bytes: Uint8Array): OutputLogChunk {
    this.#assertActive();
    if (this.#closeEvent) throw new Error("cannot append output after close");
    if (bytes.byteLength > this.#maxChunkBytes) {
      throw new RangeError(`output chunk exceeds ${this.#maxChunkBytes} bytes`);
    }

    // Own the bytes so a caller cannot mutate replayed output after append returns.
    const ownedBytes = Uint8Array.from(bytes);
    const seq = this.#nextSeq++;
    this.#chunks.set(seq, { bytes: ownedBytes, stream });
    this.#retainedBytes += ownedBytes.byteLength;
    this.#evictOldest();
    this.#notify();

    return Object.freeze({ seq, stream, chunk: this.#encode(ownedBytes) });
  }

  exited(exitCode: number): { readonly seq: number; readonly exitCode: number } {
    this.#assertActive();
    if (this.#exitEvent) return this.#exitEvent;
    if (this.#closeEvent) throw new Error("cannot report exit after close");

    this.#exitEvent = Object.freeze({ seq: this.#nextSeq++, exitCode });
    this.#notify();
    return this.#exitEvent;
  }

  /** The owner calls close only after exit and every output stream has reached EOF. */
  close(): { readonly seq: number } {
    this.#assertActive();
    if (this.#closeEvent) return this.#closeEvent;
    if (!this.#exitEvent) throw new Error("cannot close before exit");

    this.#closeEvent = Object.freeze({ seq: this.#nextSeq++ });
    this.#notify();
    return this.#closeEvent;
  }

  async read(options: OutputLogReadOptions = {}, signal?: AbortSignal): Promise<OutputLogRead> {
    const afterSeq = limit(options.afterSeq, 0, "afterSeq");
    const maxBytes =
      options.maxBytes === undefined ? undefined : limit(options.maxBytes, 0, "maxBytes");
    const waitMs = Math.min(limit(options.waitMs, 0, "waitMs"), MAX_TIMER_DELAY_MS);
    const deadline = Date.now() + waitMs;

    while (true) {
      if (signal?.aborted) throw abortError();
      this.#assertActive();

      const remainingMs = deadline - Date.now();
      if (waitMs === 0 || remainingMs <= 0) return this.#snapshot(afterSeq, maxBytes);

      // Arm before taking the snapshot so output between the snapshot and await cannot be lost.
      const waiter = this.#subscribe(signal, remainingMs);
      const response = this.#snapshot(afterSeq, maxBytes);
      if (this.#hasData(response, afterSeq)) {
        waiter.cancel();
        return response;
      }

      const result = await waiter.promise;
      if (result === "aborted") throw abortError();
      if (result === "timeout") return this.#snapshot(afterSeq, maxBytes);
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#chunks.clear();
    this.#retainedBytes = 0;
    this.#notify();
  }

  #snapshot(afterSeq: number, maxBytes: number | undefined): OutputLogRead {
    const chunks: OutputLogChunk[] = [];
    let totalBytes = 0;
    let nextSeq = this.#nextSeq;

    for (const [seq, retained] of this.#chunks) {
      if (seq <= afterSeq) continue;
      const chunkBytes = retained.bytes.byteLength;
      if (maxBytes !== undefined && chunks.length > 0 && totalBytes + chunkBytes > maxBytes) {
        break;
      }
      chunks.push(
        Object.freeze({ seq, stream: retained.stream, chunk: this.#encode(retained.bytes) }),
      );
      totalBytes += chunkBytes;
      nextSeq = seq + 1;
      if (maxBytes !== undefined && totalBytes >= maxBytes) break;
    }

    // With no byte budget, Codex reports the current shared event cursor, including exit/close.
    if (maxBytes === undefined) nextSeq = this.#nextSeq;
    return {
      chunks,
      nextSeq,
      exited: this.#exitEvent !== undefined,
      exitCode: this.#exitEvent?.exitCode ?? null,
      closed: this.#closeEvent !== undefined,
      failure: null,
      sandboxDenied: false,
    };
  }

  #hasData(response: OutputLogRead, afterSeq: number) {
    return (
      response.chunks.length > 0 ||
      response.closed ||
      (response.exited && afterSeq < response.nextSeq - 1)
    );
  }

  #subscribe(signal: AbortSignal | undefined, timeoutMs: number): Waiter {
    let resolve!: (result: WakeResult) => void;
    const promise = new Promise<WakeResult>((complete) => {
      resolve = complete;
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => finish("changed");
    const onAbort = () => finish("aborted");
    const cleanup = () => {
      this.#waiters.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const finish = (result: WakeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    this.#waiters.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    if (signal?.aborted) finish("aborted");
    return { promise, cancel: () => finish("cancelled") };
  }

  #evictOldest() {
    while (this.#retainedBytes > this.#maxBytes || this.#chunks.size > this.#maxChunks) {
      const oldest = this.#chunks.entries().next().value as [number, RetainedChunk] | undefined;
      if (!oldest) return;
      this.#chunks.delete(oldest[0]);
      this.#retainedBytes -= oldest[1].bytes.byteLength;
    }
  }

  #encode(bytes: Uint8Array) {
    return NodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
  }

  #notify() {
    for (const wake of this.#waiters) wake();
  }

  #assertActive() {
    if (this.#disposed) throw abortError("Output log has been disposed");
  }
}
