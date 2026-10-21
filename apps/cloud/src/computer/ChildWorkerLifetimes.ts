/** One catalog joins all descendants, including children started while drain is already waiting. */
export class ChildWorkerLifetimes {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #failures: unknown[] = [];

  track(lifetime: Promise<unknown>): void {
    this.#pending.add(lifetime);
    void lifetime.then(
      () => this.#pending.delete(lifetime),
      (error: unknown) => {
        settleStacks(error);
        this.#failures.push(error);
        this.#pending.delete(lifetime);
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

/**
 * Failures wait here for the whole session. V8 keeps an unread stack as live frames that pin each
 * frame's closures, such as a failed command's kernel program and pipes; formatting it frees them.
 */
function settleStacks(error: unknown): void {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth++) {
    void current.stack;
    current = current.cause;
  }
}
