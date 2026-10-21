/** One catalog joins all descendants, including children started while drain is already waiting. */
export class ChildWorkerLifetimes {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #failures: unknown[] = [];

  track(lifetime: Promise<unknown>): void {
    this.#pending.add(lifetime);
    void lifetime.then(
      () => this.#pending.delete(lifetime),
      (error: unknown) => {
        this.#failures.push(error);
        this.#pending.delete(lifetime);
        settleStacks(error);
      },
    );
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
    if (this.#failures.length === 1) throw this.#failures[0];
    if (this.#failures.length > 1) {
      throw new AggregateError(this.#failures, "Child program cleanup failed");
    }
  }
}

/** V8 shares one native getter for every error's lazily formatted stack. */
const nativeStack = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const MAX_SETTLED = 1024;

/**
 * Failures wait here for the whole session. V8 keeps an unread stack as live frames that pin each
 * frame's closures, such as a failed command's kernel program and pipes; formatting it frees them.
 * Only own data properties and V8's own stack getter are read, so no failure's code runs here, and
 * the walk is bounded.
 */
function settleStacks(error: unknown): void {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  const enqueue = (holder: object, key: PropertyKey) => {
    const link = Object.getOwnPropertyDescriptor(holder, key);
    if (link !== undefined && "value" in link && pending.length < MAX_SETTLED) {
      pending.push(link.value);
    }
  };
  while (pending.length > 0 && seen.size < MAX_SETTLED) {
    const next = pending.pop();
    if (typeof next !== "object" || next === null || seen.has(next)) continue;
    seen.add(next);
    try {
      const stack = Object.getOwnPropertyDescriptor(next, "stack");
      if (stack?.get !== undefined && stack.get === nativeStack) stack.get.call(next);
    } catch {
      // The failure is already recorded; an unformattable stack only stays unformatted.
    }
    try {
      enqueue(next, "cause");
      const errors = Object.getOwnPropertyDescriptor(next, "errors");
      const members: unknown = errors !== undefined && "value" in errors ? errors.value : undefined;
      if (Array.isArray(members)) {
        for (let index = 0; index < Math.min(members.length, MAX_SETTLED); index++) {
          enqueue(members, index);
        }
      }
    } catch {
      // Unreadable links are skipped.
    }
  }
}
