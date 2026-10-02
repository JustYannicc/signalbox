/**
 * "Based on your usage": one plain suggestion per harness from pooled
 * capacity and recent pace. PLACEHOLDER math on fixture burn rates; the real
 * version would read the token history the Tokens view already has.
 */
import { POOL_LABEL, weeklyWindow, type PoolCapacity, type PoolHarness } from "./accountPoolsModel";

const DAY = 86_400_000;

export type UsageAdvice = {
  readonly harness: PoolHarness;
  readonly tone: "warning" | "saving" | "ok";
  readonly text: string;
  readonly action?: { readonly label: string; readonly detail: string };
};

export function adviseFromUsage(
  capacity: PoolCapacity,
  pacePerDay: number,
  now: number,
): UsageAdvice {
  const label = POOL_LABEL[capacity.harness];
  const daysLeft = pacePerDay > 0 ? capacity.left / pacePerDay : Number.POSITIVE_INFINITY;
  const runsOutAt = now + daysLeft * DAY;

  if (capacity.nextResetAt !== null && runsOutAt < capacity.nextResetAt) {
    const weekday = new Date(runsOutAt).toLocaleDateString(undefined, { weekday: "short" });
    return {
      harness: capacity.harness,
      tone: "warning",
      text: `${label} runs out ${weekday} at your current pace`,
      action: { label: "Add account", detail: "Add 1 Pro account" },
    };
  }

  const underused = capacity.accounts.find((account) => {
    const used = weeklyWindow(account)?.usedPercent ?? 100;
    return account.state === "active" && account.plan.startsWith("Max") && used <= 25;
  });
  if (underused) {
    const used = Math.round(weeklyWindow(underused)?.usedPercent ?? 0);
    return {
      harness: capacity.harness,
      tone: "saving",
      text: `${label} ${underused.plan} is ${used}% used this week. You could drop to Pro`,
      action: { label: "Review", detail: underused.name },
    };
  }

  return {
    harness: capacity.harness,
    tone: "ok",
    text: Number.isFinite(daysLeft)
      ? `${label}: fine, about ${Math.round(daysLeft)} days of headroom`
      : `${label}: fine`,
  };
}
