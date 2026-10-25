import * as NodeBuffer from "node:buffer";

import type { NodeExecOptions } from "./arguments.ts";

export interface OutputOptions {
  readonly maxBuffer: number;
  readonly encoding: BufferEncoding | null;
}

export function normalizeOutputOptions(
  options: NodeExecOptions,
  defaultEncoding: BufferEncoding | null = "utf8",
): OutputOptions {
  return {
    maxBuffer: normalizeMaxBuffer(options.maxBuffer),
    encoding: normalizeEncoding(options.encoding, defaultEncoding),
  };
}

export function normalizeMaxBuffer(maxBuffer: number | undefined): number {
  if (maxBuffer === undefined) return 1024 * 1024;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
    throw new RangeError('The "maxBuffer" option must be a non-negative safe integer');
  }
  return maxBuffer;
}

export function normalizeEncoding(
  encoding: NodeExecOptions["encoding"],
  defaultEncoding: BufferEncoding | null = "utf8",
): BufferEncoding | null {
  if (encoding === null || encoding === "buffer") return null;
  const value = encoding ?? defaultEncoding;
  if (value === null) return null;
  if (!NodeBuffer.Buffer.isEncoding(value)) throw new TypeError(`Unknown encoding: ${value}`);
  return value;
}

export class ByteCollector {
  readonly #chunks: NodeBuffer.Buffer[] = [];
  readonly #maxBuffer: number;
  #received = 0;
  #stored = 0;
  exceeded = false;
  onLimit: (() => void) | undefined;

  constructor(maxBuffer: number) {
    this.#maxBuffer = maxBuffer;
  }

  append(value: unknown): void {
    const bytes = toBuffer(value);
    const remaining = Math.max(0, this.#maxBuffer - this.#stored);
    if (remaining > 0) {
      const kept = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
      // A sync host can reuse its write buffer as soon as this method returns.
      this.#chunks.push(NodeBuffer.Buffer.from(kept));
      this.#stored += kept.byteLength;
    }
    this.#received += bytes.byteLength;
    if (!this.exceeded && this.#received > this.#maxBuffer) {
      this.exceeded = true;
      this.onLimit?.();
    }
  }

  output(encoding: BufferEncoding | null): NodeBuffer.Buffer | string {
    const result = NodeBuffer.Buffer.concat(this.#chunks, this.#stored);
    return encoding === null ? result : result.toString(encoding);
  }
}

function toBuffer(value: unknown): NodeBuffer.Buffer {
  if (NodeBuffer.Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return NodeBuffer.Buffer.from(value);
  if (value instanceof Uint8Array) return NodeBuffer.Buffer.from(value);
  throw new TypeError("child_process output must be bytes or a string");
}
