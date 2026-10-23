import { KERNEL_SYSCALL_INITIAL_WINDOW } from "./KernelSyscallPort.ts";

export const KERNEL_OWNER_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_WINDOW = 1024 * 1024;
const PIPE_RETAINED_BYTES = 16 * 1024 * 1024;
// Leave admission room for the existing 64-worker ceiling, including a late pipe reader.
const ADMISSION_HEADROOM = 64 * 2 * KERNEL_SYSCALL_INITIAL_WINDOW;

const ownedBuffers = new WeakSet<ArrayBufferLike>();

/** A syscall's reservation already covers this buffer, including a coalesced vector copy. */
export function ownKernelPayload<Buffer extends ArrayBufferLike>(bytes: Uint8Array<Buffer>) {
  ownedBuffers.add(bytes.buffer);
  return bytes;
}

export function isKernelPayloadOwned(bytes: Uint8Array) {
  return ownedBuffers.has(bytes.buffer);
}

interface WindowState {
  window: number;
  reserved: number;
  released: boolean;
}

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (window: KernelPayloadWindow) => void;
  readonly reject: (error: unknown) => void;
  readonly abort: () => void;
}

export interface KernelPayloadWindow {
  readonly bytes: number;
  acknowledge(): void;
  complete(responseBytes: number): number;
  release(): void;
}

/** Isolate-wide credits cover shortenable WASI I/O and retained pipe payloads. */
class KernelPayloadBudget {
  #reserved = 0;
  #windows = 0;
  #pipeBytes = 0;
  readonly #waiting = new Set<Waiter>();

  open(signal: AbortSignal): Promise<KernelPayloadWindow> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#waiting.size === 0 && this.#available >= 2 * KERNEL_SYSCALL_INITIAL_WINDOW) {
      return Promise.resolve(this.#open());
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#waiting.delete(waiter);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const waiter = { signal, resolve, reject, abort };
      this.#waiting.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  retainPipe(source: Uint8Array, maximum: number) {
    const borrowed = isKernelPayloadOwned(source);
    const bytes = Math.min(
      source.byteLength,
      maximum,
      PIPE_RETAINED_BYTES - this.#pipeBytes,
      borrowed ? maximum : Math.max(0, this.#available - ADMISSION_HEADROOM),
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
        this.#drain();
      },
    };
  }

  get #available() {
    return KERNEL_OWNER_PAYLOAD_BYTES - this.#reserved;
  }

  #open(): KernelPayloadWindow {
    const state: WindowState = {
      window: KERNEL_SYSCALL_INITIAL_WINDOW,
      reserved: 2 * KERNEL_SYSCALL_INITIAL_WINDOW,
      released: false,
    };
    this.#windows++;
    this.#reserved += state.reserved;
    const reserve = (bytes: number) => {
      this.#reserved += bytes - state.reserved;
      state.reserved = bytes;
    };
    return {
      get bytes() {
        return state.window;
      },
      acknowledge: () => {
        // A subsequent request acknowledges that the preceding reply reached the child.
        reserve(2 * state.window);
      },
      complete: (responseBytes) => {
        if (state.released) throw new Error("Syscall payload window was released");
        const available = this.#available + state.reserved;
        const fair = Math.floor(
          (KERNEL_OWNER_PAYLOAD_BYTES - ADMISSION_HEADROOM) / (2 * this.#windows),
        );
        let window = Math.max(KERNEL_SYSCALL_INITIAL_WINDOW, Math.min(MAX_WINDOW, fair));
        const room = Math.max(state.reserved, available - ADMISSION_HEADROOM);
        // Before ACK, only the next incoming snapshot can coexist with the old reply.
        // After ACK, two windows cover input plus a discontiguous vector copy.
        while (
          window + Math.max(window, responseBytes) > room &&
          window > KERNEL_SYSCALL_INITIAL_WINDOW
        ) {
          window = Math.max(KERNEL_SYSCALL_INITIAL_WINDOW, Math.floor(window / 2));
        }
        reserve(window + Math.max(window, responseBytes));
        state.window = window;
        this.#drain();
        return window;
      },
      release: () => {
        if (state.released) return;
        state.released = true;
        this.#windows--;
        reserve(0);
        this.#drain();
      },
    };
  }

  #drain() {
    while (this.#available >= 2 * KERNEL_SYSCALL_INITIAL_WINDOW) {
      const waiter = this.#waiting.values().next().value;
      if (waiter === undefined) return;
      this.#waiting.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) waiter.reject(waiter.signal.reason);
      else waiter.resolve(this.#open());
    }
  }
}

export const kernelPayloadBudget = new KernelPayloadBudget();
