/**
 * A child worker's stub to its host can outlive the command: Workers RPC releases stubs when the
 * whole event ends, and a harness session is one event. Host ports therefore reach kernel state
 * only through refs this lease owns, so a lingering export pins nothing once the command closes.
 */
export class ChildHostLease {
  #values: Map<ChildHostRef<unknown>, unknown> | undefined = new Map();

  hold<Value>(value: Value): ChildHostRef<Value> {
    const ref = new ChildHostRef<Value>(this);
    // A fork can resolve after close; its port is born released.
    this.#values?.set(ref, value);
    return ref;
  }

  /** Releases one ref early, for a process that finished before its command did. */
  drop(ref: ChildHostRef<unknown>): void {
    this.#values?.delete(ref);
  }

  release(): void {
    this.#values = undefined;
  }

  read<Value>(ref: ChildHostRef<Value>): Value {
    if (!this.#values?.has(ref)) {
      throw Object.assign(new Error("Child host is closed"), { code: "EBADF" });
    }
    return this.#values.get(ref) as Value;
  }
}

export class ChildHostRef<Value> {
  readonly #lease: ChildHostLease;

  constructor(lease: ChildHostLease) {
    this.#lease = lease;
  }

  get(): Value {
    return this.#lease.read(this);
  }
}
