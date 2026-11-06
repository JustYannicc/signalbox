/**
 * Descriptors a child is about to inherit as stdio. Node duplicates them inside `spawn()`, so a
 * parent may close its own copy at once, as Claude Code's Bash tool does with its output file.
 * Here the spawn reaches Computer later, so a close of a held descriptor waits until it has.
 */
export class CliDescriptorHolds {
  readonly #holds = new Map<number, Set<Promise<void>>>();

  hold(fds: readonly number[]) {
    const done = Promise.withResolvers<void>();
    const held = [...new Set(fds)];
    for (const fd of held) {
      const holds = this.#holds.get(fd) ?? new Set();
      holds.add(done.promise);
      this.#holds.set(fd, holds);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const fd of held) {
        const holds = this.#holds.get(fd);
        holds?.delete(done.promise);
        if (holds?.size === 0) this.#holds.delete(fd);
      }
      done.resolve();
    };
  }

  /** Resolves once no spawn still needs `fd`, or is undefined when none does. */
  released(fd: number) {
    const holds = this.#holds.get(fd);
    return holds === undefined ? undefined : Promise.all(holds).then(() => undefined);
  }
}
