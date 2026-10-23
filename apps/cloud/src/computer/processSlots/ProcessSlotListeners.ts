export class ProcessSlotListeners<T> {
  readonly #listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(value: T): void {
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // Supervisor observers cannot interrupt allocation or suppress another observer.
      }
    }
  }
}
