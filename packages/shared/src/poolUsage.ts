/**
 * A pool's usage as its members may see it: each provider's windows pooled
 * across the accounts that take turns, the share left and the next reset.
 * Shared by self-hosted pools (`apps/server/src/accountHub/poolOverview.ts`)
 * and cloud pools (`apps/cloud/src/pool/poolViews.ts`).
 *
 * @module poolUsage
 */
import type { ServerProviderUsageWindow, UsageLimitSourceAccount } from "@t3tools/contracts";
import type { AccountPoolUsageWindow } from "@t3tools/contracts/accountHub";

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** Accounts the pool routes turns to: paused and signed-out ones take none. */
export const takesTurns = (account: UsageLimitSourceAccount) =>
  !account.disabled && !account.signedOut;

/**
 * A window as it stands at `now`: one whose reset has passed since the last
 * read is open again, and has no reset ahead.
 */
export const asOf = (window: ServerProviderUsageWindow, now: number): ServerProviderUsageWindow => {
  const { resetsAt, ...rest } = window;
  if (resetsAt === undefined) return window;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return rest;
  return at > now ? window : { ...rest, usedPercent: 0 };
};

/**
 * One provider's windows pooled across its accounts: the mean share left, as
 * the Limits view shows it, and the soonest reset that hands quota back.
 */
export function pooledUsage(
  accounts: ReadonlyArray<UsageLimitSourceAccount>,
  now: number,
): ReadonlyArray<AccountPoolUsageWindow> {
  const byWindow = new Map<string, ServerProviderUsageWindow[]>();
  for (const account of accounts) {
    for (const window of account.usageLimits.windows) {
      const key = `${window.kind}:${window.id}`;
      const windows = byWindow.get(key) ?? [];
      windows.push(asOf(window, now));
      byWindow.set(key, windows);
    }
  }
  return [...byWindow.values()]
    .map((windows) => {
      const first = windows[0]!;
      const used = windows.reduce((sum, window) => sum + window.usedPercent, 0) / windows.length;
      // An untouched account's reset gives nothing back.
      const nextResetAt = windows
        .filter((window) => window.usedPercent > 0)
        .flatMap((window) => (window.resetsAt === undefined ? [] : [window.resetsAt]))
        .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
      return {
        label: first.label,
        kind: first.kind,
        remainingPercent: Math.round(100 - used),
        ...(nextResetAt ? { nextResetAt } : {}),
      };
    })
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

/** Whether an account has quota left in every window it reports. */
export const hasQuota = (account: UsageLimitSourceAccount, now: number) =>
  account.usageLimits.windows.every((window) => asOf(window, now).usedPercent < 100);
