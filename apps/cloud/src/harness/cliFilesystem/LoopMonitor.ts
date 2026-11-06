// @effect-diagnostics globalTimers:off - The CLI view runs without an Effect runtime.
import type { CliViewTrace } from "../CliViewTrace.ts";

/**
 * Workerd's clock does not move inside a synchronous stretch, so a long one can't time itself.
 * A timer that fires late can: the delay is how long the isolate's event loop was held.
 */
export function watchEventLoop(options: {
  readonly activity: () => string;
  readonly trace: (event: CliViewTrace) => void;
  readonly intervalMs?: number;
  readonly thresholdMs?: number;
}) {
  const interval = options.intervalMs ?? 100;
  const threshold = options.thresholdMs ?? 250;
  let expected = performance.now() + interval;
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    expected = now + interval;
    if (lag >= threshold)
      options.trace({ kind: "loop-lag", lagMs: Math.round(lag), activity: options.activity() });
  }, interval);
  return () => clearInterval(timer);
}
