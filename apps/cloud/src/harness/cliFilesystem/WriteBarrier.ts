import type { CliWorkingSetBudget } from "./Budget.ts";

/** A synchronous write is speculative until this ordered queue commits it in Computer. */
export class CliWriteBarrier {
  #tail = Promise.resolve();
  #failure: { readonly cause: unknown } | undefined;
  #closed = false;
  #version = 0;
  get version() {
    return this.#version;
  }
  readonly budget;
  constructor(budget: CliWorkingSetBudget) {
    this.budget = budget;
  }

  assertHealthy() {
    if (this.#failure !== undefined) throw this.#failure.cause;
    if (this.#closed) throw new Error("CLI filesystem working set is closed");
  }

  enqueue(bytes: number, commit: () => Promise<void>, cleanup = false, prepare?: () => void) {
    this.assertHealthy();
    const release = this.budget.reserve(bytes);
    try {
      prepare?.();
    } catch (cause) {
      release();
      throw cause;
    }
    this.#version++;
    this.#tail = this.#tail.then(async () => {
      try {
        if (this.#failure === undefined || cleanup) await commit();
      } catch (cause) {
        this.#failure ??= { cause };
      } finally {
        release();
      }
    });
  }

  async flush() {
    // A completed RPC may enqueue more writes before its continuation returns to the caller.
    let current;
    do {
      current = this.#tail;
      await current;
    } while (current !== this.#tail);
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  async close() {
    this.#closed = true;
    await this.flush();
  }
}
