type Cleanup = () => void | Promise<void>;

/** Owns asynchronous resource releases, including failed process admissions. */
export class KernelProcessCleanup {
  readonly #pending = new Set<Promise<boolean>>();
  #failed = false;

  own(release: Cleanup) {
    let cleanup: Promise<void> | undefined;
    return () => {
      if (!cleanup) cleanup = this.#start(release);
      return cleanup;
    };
  }

  async drain() {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
    return !this.#failed;
  }

  #start(release: Cleanup) {
    const pending = Promise.resolve()
      .then(release)
      .then(
        () => true,
        () => false,
      );
    this.#pending.add(pending);
    void pending.then((success) => {
      if (!success) this.#failed = true;
      this.#pending.delete(pending);
    });
    return pending.then(() => undefined);
  }
}
