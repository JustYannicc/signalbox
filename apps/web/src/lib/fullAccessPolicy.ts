import type { RuntimeMode } from "@t3tools/contracts";

/**
 * Fork: agents run in sandboxes (durable objects), so every run gets full
 * access and the composer offers no permission picker. The model can still
 * ask when it makes sense. Flip to `false` to restore upstream's per-thread
 * access modes; stored settings and thread modes are never rewritten here,
 * a thread only moves to full access when it next sends.
 */
export const ALWAYS_FULL_ACCESS = true;

/** The runtime mode a run actually uses under the fork's policy. */
export function effectiveRuntimeMode(mode: RuntimeMode): RuntimeMode {
  return ALWAYS_FULL_ACCESS ? "full-access" : mode;
}
