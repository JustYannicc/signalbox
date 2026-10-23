import { KERNEL_SYSCALL_INITIAL_WINDOW } from "./KernelSyscallPort.ts";

const KERNEL_OWNER_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_WINDOW = 1024 * 1024;
const PIPE_RETAINED_BYTES = 16 * 1024 * 1024;
const ownedBuffers = new WeakSet<ArrayBufferLike>();

/** A syscall's reservation already covers this buffer, including a coalesced vector copy. */
export function ownKernelPayload<Buffer extends ArrayBufferLike>(bytes: Uint8Array<Buffer>) {
  ownedBuffers.add(bytes.buffer);
  return bytes;
}

export function isKernelPayloadOwned(bytes: Uint8Array) {
  return ownedBuffers.has(bytes.buffer);
}

export interface KernelPayloadWindow {
  readonly bytes: number;
  release(): void;
}

/** Credits cover I/O payloads across commands; a bounded floor always permits progress. */
class KernelPayloadBudget {
  #reserved = 0;
  #pipeBytes = 0;

  open(signal: AbortSignal, responseBytes = 0): Promise<KernelPayloadWindow> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const available = this.#available;
    let bytes = MAX_WINDOW;
    // Before the next call acknowledges the reply, that reply can coexist with its input.
    // Afterwards the reservation covers input plus a coalesced copy, or output plus snapshot.
    const cost = () => Math.max(2 * bytes, responseBytes + bytes);
    while (cost() > available && bytes > KERNEL_SYSCALL_INITIAL_WINDOW)
      bytes = Math.max(KERNEL_SYSCALL_INITIAL_WINDOW, Math.floor(bytes / 2));
    // At saturation, each call still gets PIPE_BUF bytes without waiting on another process.
    // Only that fixed floor is unbudgeted; a preceding reply retains its existing charge.
    const reserved = cost() <= available ? cost() : Math.min(responseBytes, available);
    this.#reserved += reserved;
    let released = false;
    return Promise.resolve({
      bytes,
      release: () => {
        if (released) return;
        released = true;
        this.#reserved -= reserved;
      },
    });
  }

  retainPipe(source: Uint8Array, maximum: number) {
    const borrowed = isKernelPayloadOwned(source);
    const bytes = Math.min(
      source.byteLength,
      maximum,
      PIPE_RETAINED_BYTES - this.#pipeBytes,
      borrowed ? maximum : this.#available,
    );
    this.#pipeBytes += bytes;
    if (!borrowed) this.#reserved += bytes;
    let released = false;
    return {
      bytes,
      release: () => {
        if (released) return;
        released = true;
        this.#pipeBytes -= bytes;
        if (!borrowed) this.#reserved -= bytes;
      },
    };
  }

  get #available() {
    return Math.max(0, KERNEL_OWNER_PAYLOAD_BYTES - this.#reserved);
  }
}

export const kernelPayloadBudget = new KernelPayloadBudget();
