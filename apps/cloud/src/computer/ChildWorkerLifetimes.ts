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
