interface AdmissionWaiter {
  readonly signal?: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  onAbort?: () => void;
}

/** Serializes command brackets and removes callers that abort while queued. */
export class MachineCommandAdmission {
  #held = false;
  readonly #waiters: AdmissionWaiter[] = [];

  tryAcquire(signal?: AbortSignal): (() => void) | undefined {
    if (signal?.aborted) throw abortReason(signal);
    if (this.#held || this.#waiters.length > 0) return undefined;
    this.#held = true;
    return this.#releaseHandle();
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.#held && this.#waiters.length === 0) {
      this.#held = true;
      return Promise.resolve(this.#releaseHandle());
    }

    return new Promise((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      };
      this.#waiters.push(waiter);
      if (!signal) return;

      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.onAbort!);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }

  #releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (this.#waiters.length > 0) {
        const waiter = this.#waiters.shift()!;
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        if (waiter.signal?.aborted) {
          waiter.reject(abortReason(waiter.signal));
          continue;
        }
        waiter.resolve(this.#releaseHandle());
        return;
      }

      this.#held = false;
    };
  }
}

const abortReason = (signal: AbortSignal) =>
  signal.reason ?? new DOMException("Aborted", "AbortError");
