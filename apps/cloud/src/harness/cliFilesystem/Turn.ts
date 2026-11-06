// @effect-diagnostics globalTimers:off - The CLI view runs without an Effect runtime.
/**
 * Computer's SQLite-backed reads resolve without I/O, so a long walk of awaits runs as one
 * microtask chain and starves timers, RPC and the inspector. Long passes yield a macrotask turn
 * every so often instead.
 */
export function nextTurn() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Yields after `items` steps or `bytes` of work, whichever comes first. */
export function turnBudget(items = 256, bytes = 4 * 1024 * 1024) {
  let steps = 0;
  let work = 0;
  return async (weight = 0) => {
    steps++;
    work += weight;
    if (steps < items && work < bytes) return;
    steps = 0;
    work = 0;
    await nextTurn();
  };
}
