/**
 * Reset credits per window. Claude has 5-hour and full resets, so each of its
 * windows counts only the credits that clear it and redeems its own credit;
 * a 5-hour ticket never spends the full reset. Providers that do not split
 * their credits show the account's credits on every window.
 *
 * @module usageLimitWindows
 */
import type { ServerProviderResetCredits } from "@t3tools/contracts";

import type { LimitAccount } from "./usageLimits.ts";

/** The credits one window can use; undefined when none clear it. */
export function windowResetCredits(
  account: LimitAccount,
  windowId: string,
): ServerProviderResetCredits | undefined {
  const credits = account.limits.resetCredits;
  if (!credits?.windows) return credits;
  const own = credits.windows.find((entry) => entry.windowId === windowId);
  if (!own) return undefined;
  const { windowId: _windowId, ...rest } = own;
  return rest;
}

/**
 * Where a window's credit is redeemed, pinned to that window's own credit.
 * Null when the window has nothing to redeem, or when the target cannot be
 * pinned (a native instance claims the account-wide credit) and that credit is
 * not the window's.
 */
export function windowRedeem(account: LimitAccount, windowId: string): LimitAccount["redeem"] {
  const redeem = account.redeem;
  const credits = windowResetCredits(account, windowId);
  if (!redeem || !credits || credits.availableCount === 0) return null;
  if (!credits.nextCreditId) return redeem;
  if ("creditId" in redeem.input) {
    return { ...redeem, input: { ...redeem.input, creditId: credits.nextCreditId } };
  }
  return credits.nextCreditId === account.limits.resetCredits?.nextCreditId ? redeem : null;
}
