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

/**
 * Failures wait here for the whole session. V8 keeps an unread stack as live frames that pin each
 * frame's closures, such as a failed command's kernel program and pipes; formatting it frees them.
 * Best effort: a hostile getter only leaves that one error's frames alive.
 */
function settleStacks(error: unknown): void {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length > 0) {
    const next = pending.pop();
    try {
      if (!(next instanceof Error) || seen.has(next)) continue;
      seen.add(next);
      void next.stack;
      pending.push(next.cause);
      // Only real arrays are walked: an arbitrary iterable could be endless.
      const members: unknown = next instanceof AggregateError ? next.errors : undefined;
      if (Array.isArray(members)) for (const member of members) pending.push(member);
    } catch {
      // An unreadable stack, cause or member is skipped; the failure is already recorded.
    }
  }
}
