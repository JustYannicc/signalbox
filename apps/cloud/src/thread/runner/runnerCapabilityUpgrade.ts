import type { MachineLease } from "../ThreadStore.ts";

/** Replace once, after saving; a stale replacement stays blocked until a newer hello arrives. */
export function runnerCapabilityUpgrade(
  lease: MachineLease,
  required: boolean,
  supported: boolean,
  attempted: boolean,
  now: number,
  drainTimeoutMs: number,
) {
  if (lease.status !== "connected" || lease.disconnectedAt !== null || !required || supported)
    return { type: "none" } as const;
  if (attempted) return { type: "blocked" } as const;
  if (lease.drains !== true) return { type: "replace" } as const;
  if (lease.drain === undefined) return { type: "drain" } as const;
  if (lease.drain._tag === "answered") return { type: "replace" } as const;
  const deadline = lease.drain.id + drainTimeoutMs;
  return now >= deadline ? ({ type: "replace" } as const) : ({ type: "wait", deadline } as const);
}
