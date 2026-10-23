/**
 * A child worker's stub to its host can outlive the command: Workers RPC releases stubs when the
 * whole event ends, and a harness session is one event. Host ports therefore reach kernel state
 * only through refs this lease clears, so a lingering export pins nothing once the command closes.
 */
export class ChildHostLease {
  #refs: Set<ChildHostRef<unknown>> | undefined = new Set();
  readonly #onObserve: ((residentBytes: number) => void) | undefined;

  constructor(onObserve?: (residentBytes: number) => void) {
    this.#onObserve = onObserve;
  }

  observe(residentBytes: number): void {
    if (this.#refs === undefined) throw closedHostError();
    if (!Number.isSafeInteger(residentBytes) || residentBytes < 0) {
      throw new RangeError("Child host memory size must be a nonnegative safe integer");
    }
    this.#onObserve?.(residentBytes);
  }

  hold<Value>(value: Value, onRelease?: (value: Value) => void): ChildHostRef<Value> {
    const ref = new ChildHostRef(value, onRelease);
    // A fork can resolve after close; its port is born released.
    if (this.#refs === undefined) ref[release]();
    else this.#refs.add(ref);
    return ref;
  }

  /** Releases one ref early, for a process that finished before its command did. */
  drop(ref: ChildHostRef<unknown>): void {
    ref[release]();
    this.#refs?.delete(ref);
  }

  release(): void {
    for (const ref of this.#refs ?? []) ref[release]();
    this.#refs = undefined;
  }
}

const release = Symbol("release");

export class ChildHostRef<Value> {
  #value: Value | undefined;
  readonly #onRelease: ((value: Value) => void) | undefined;

  constructor(value: Value, onRelease?: (value: Value) => void) {
    this.#value = value;
    this.#onRelease = onRelease;
  }

  get(): Value {
    if (this.#value === undefined) {
      throw closedHostError();
    }
    return this.#value;
  }

  /** Only the lease clears a ref, so holders can't revoke each other's access. */
  [release](): void {
    const value = this.#value;
    this.#value = undefined;
    if (value !== undefined) this.#onRelease?.(value);
  }
}

function closedHostError() {
  return Object.assign(new Error("Child host is closed"), { code: "EBADF" });
}
