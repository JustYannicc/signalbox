import type { WasiPollResult } from "../KernelDescriptors.ts";
import { fail, NET_ERRNO } from "./Memory.ts";
import { HTTP_LIMITS } from "./Types.ts";

export class HttpResponseQueue {
  readonly #chunks: Uint8Array[] = [];
  readonly #notify: () => void;
  #offset = 0;
  #size = 0;
  #ended = false;
  #error: number | undefined;
  #drain: (() => void) | undefined;

  constructor(notify: () => void) {
    this.#notify = notify;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length > HTTP_LIMITS.responseQueueBytes) fail(NET_ERRNO.MSGSIZE);
    while (!this.#ended && this.#size + bytes.length > HTTP_LIMITS.responseQueueBytes) {
      await new Promise<void>((resolve) => {
        this.#drain = resolve;
      });
    }
    if (this.#ended) fail(this.#error ?? NET_ERRNO.BADF);
    if (bytes.length === 0) return;
    this.#chunks.push(bytes);
    this.#size += bytes.length;
    this.#notify();
  }

  read(output: Uint8Array): number {
    if (output.length === 0) return 0;
    if (this.#size === 0) {
      if (this.#error !== undefined) fail(this.#error);
      if (this.#ended) return 0;
      return fail(NET_ERRNO.AGAIN);
    }
    let count = 0;
    while (count < output.length && this.#chunks.length > 0) {
      const head = this.#chunks[0]!;
      const amount = Math.min(output.length - count, head.length - this.#offset);
      output.set(head.subarray(this.#offset, this.#offset + amount), count);
      this.#offset += amount;
      count += amount;
      this.#size -= amount;
      if (this.#offset === head.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    const resume = this.#drain;
    this.#drain = undefined;
    resume?.();
    return count;
  }

  ready(): WasiPollResult | undefined {
    if (this.#size > 0 || this.#ended)
      return { bytes: BigInt(this.#size), ...(this.#ended ? { hangup: true } : {}) };
    return undefined;
  }

  end(error?: number, discard = false): void {
    this.#ended = true;
    this.#error ??= error;
    if (discard) {
      this.#chunks.length = 0;
      this.#size = this.#offset = 0;
    }
    const resume = this.#drain;
    this.#drain = undefined;
    resume?.();
    this.#notify();
  }
}
