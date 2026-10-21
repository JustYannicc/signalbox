/**
 * A child worker's stub to its host can outlive the command: Workers RPC releases stubs when the
 * whole event ends, and a harness session is one event. Host ports therefore reach kernel state
 * only through refs this lease clears, so a lingering export pins nothing once the command closes.
 */
export class ChildHostLease {
  #refs: Set<ChildHostRef<unknown>> | undefined = new Set();

  hold<Value>(value: Value): ChildHostRef<Value> {
    const ref = new ChildHostRef(value);
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

  constructor(value: Value) {
    this.#value = value;
  }

  get(): Value {
    if (this.#value === undefined) {
      throw Object.assign(new Error("Child host is closed"), { code: "EBADF" });
    }
    return this.#value;
  }

  /** Only the lease clears a ref, so holders can't revoke each other's access. */
  [release](): void {
    this.#value = undefined;
  }
}
