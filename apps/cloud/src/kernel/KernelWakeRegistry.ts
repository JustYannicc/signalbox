// @effect-diagnostics cryptoRandomUUID:off globalTimers:off - request-owned host notifications run without an Effect runtime.
import { captureKernelCpuExecution } from "./KernelCpuExecution.ts";

export interface WakeToken {
  readonly id: string;
}

type WakeErrorCode =
  | "INVALID_HANDLE"
  | "RESOURCE_LIMIT"
  | "CANCELLED"
  | "EXPIRED"
  | "ALREADY_WAITING"
  | "IO_ERROR";
type WakeResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | {
      readonly status: "error";
      readonly error: { readonly code: WakeErrorCode; readonly message: string };
    };
export type WakeSubscription = (wake: () => void) => () => void;
type WakeCompletion = WakeResult<void>;
type Entry = {
  completion: WakeCompletion | undefined;
  waiter: ((result: WakeCompletion) => void) | undefined;
  unsubscribe: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
};

const failure = (code: WakeErrorCode, message: string) =>
  ({ status: "error", error: { code, message } }) as const;
const ready = { status: "ok", value: undefined } as const;

/** Request-owned, one-shot readiness notifications. Readiness means retry the operation. */
export class KernelWakeRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #maxTokens: number;
  readonly #ttlMs: number;
  #closed = false;

  constructor(options: { maxTokens?: number; ttlMs?: number } = {}) {
    this.#maxTokens = options.maxTokens ?? 1024;
    this.#ttlMs = options.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(this.#maxTokens) || this.#maxTokens < 1) {
      throw new RangeError("maxTokens must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > 2_147_483_647) {
      throw new RangeError("ttlMs must fit a positive platform timer");
    }
  }

  get size() {
    return this.#entries.size;
  }

  has(token: WakeToken) {
    return this.#entries.has(token.id);
  }

  /** Install the subscription before attempting I/O, including when it wakes synchronously. */
  register(subscribe: WakeSubscription): WakeResult<WakeToken> {
    if (this.#closed) return failure("CANCELLED", "Wake registry is closed");
    if (this.size >= this.#maxTokens) return failure("RESOURCE_LIMIT", "Too many wake tokens");
    const token = Object.freeze({ id: crypto.randomUUID() });
    const entry: Entry = {
      completion: undefined,
      waiter: undefined,
      unsubscribe: undefined,
      timer: setTimeout(() => {
        this.#complete(token, failure("EXPIRED", "Wake token expired"));
        this.#entries.delete(token.id);
      }, this.#ttlMs),
    };
    this.#entries.set(token.id, entry);
    try {
      const unsubscribe = subscribe(() => this.signal(token));
      if (entry.completion || !this.#entries.has(token.id)) {
        this.#cleanup(unsubscribe);
      } else {
        entry.unsubscribe = unsubscribe;
      }
      if (!this.#entries.has(token.id))
        return failure("CANCELLED", "Wake registration was released");
      return { status: "ok", value: token };
    } catch {
      this.release(token);
      return failure("IO_ERROR", "Wake subscription failed");
    }
  }

  signal(token: WakeToken) {
    return this.#complete(token, ready);
  }

  cancel(token: WakeToken) {
    return this.#complete(token, failure("CANCELLED", "Operation cancelled"));
  }

  wait(token: WakeToken, signal?: AbortSignal): Promise<WakeCompletion> {
    const entry = this.#entries.get(token.id);
    if (!entry) return Promise.resolve(failure("INVALID_HANDLE", "Unknown or consumed wake token"));
    if (entry.waiter) return Promise.resolve(failure("ALREADY_WAITING", "Wake token has a waiter"));
    const cpuContext = captureKernelCpuExecution();
    const resumeCpu = cpuContext?.pause();
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(token);
      entry.waiter = (result) => {
        signal?.removeEventListener("abort", abort);
        const complete = () => {
          try {
            resumeCpu?.();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        };
        if (cpuContext) queueMicrotask(() => cpuContext.run(complete));
        else complete();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) this.cancel(token);
      if (entry.completion) this.release(token);
    });
  }

  /** Release notifications when the operation returned immediately or its owner exited. */
  release(token: WakeToken) {
    const entry = this.#entries.get(token.id);
    if (!entry) return false;
    this.#entries.delete(token.id);
    clearTimeout(entry.timer);
    const unsubscribe = entry.unsubscribe;
    entry.unsubscribe = undefined;
    const waiter = entry.waiter;
    entry.waiter = undefined;
    waiter?.(entry.completion ?? failure("CANCELLED", "Wake token released"));
    this.#cleanup(unsubscribe);
    return true;
  }

  dispose() {
    this.#closed = true;
    for (const id of this.#entries.keys()) this.release({ id });
  }

  #complete(token: WakeToken, completion: WakeCompletion) {
    const entry = this.#entries.get(token.id);
    if (!entry || entry.completion) return false;
    entry.completion = completion;
    const unsubscribe = entry.unsubscribe;
    entry.unsubscribe = undefined;
    if (entry.waiter) this.release(token);
    this.#cleanup(unsubscribe);
    return true;
  }

  #cleanup(unsubscribe: (() => void) | undefined) {
    try {
      unsubscribe?.();
    } catch {
      // A broken backend cleanup must not strand a waiter or retain its token.
    }
  }
}
