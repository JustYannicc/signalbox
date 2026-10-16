import type { Timer } from "./RunnerBrowserControl.ts";

/** Test helpers for the agent's browser (`RunnerBrowser*.test.ts`). */

/** Timers the test fires by hand; `armed` resolves once one for `ms` is set. */
export const manualTimers = () => {
  const set = new Set<{ readonly run: () => void; readonly ms: number }>();
  const waiting = new Set<{ readonly ms: number; readonly resolve: () => void }>();
  const timer: Timer = (run, ms) => {
    const entry = { run, ms };
    set.add(entry);
    for (const wait of waiting)
      if (wait.ms === ms) {
        waiting.delete(wait);
        wait.resolve();
      }
    return () => void set.delete(entry);
  };
  return {
    timer,
    armed: (ms: number) =>
      [...set].some((entry) => entry.ms === ms)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.add({ ms, resolve })),
    fire: (ms: number) => {
      for (const entry of set)
        if (entry.ms === ms) {
          set.delete(entry);
          entry.run();
        }
    },
  };
};
