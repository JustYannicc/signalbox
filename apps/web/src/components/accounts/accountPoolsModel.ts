/**
 * Shapes for the Accounts prototype: pooled subscription accounts, which
 * group may use each one, and the server it exits through. Windows and banked
 * resets use the same contract types the real Limits view reads, so this page
 * can switch to live data without new components.
 */
import type { ServerProviderResetCredits, ServerProviderUsageWindow } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";

/** Harnesses whose subscriptions get pooled. Keys match the usage page's provider kinds. */
export type PoolHarness = "codex" | "claude" | "grok";

export const POOL_HARNESSES: readonly PoolHarness[] = ["codex", "claude", "grok"];

export const POOL_LABEL: Record<PoolHarness, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok",
};

/** The account-side view of a Plugins group (see plugins/groupsModel.ts). */
export type AccountGroup = {
  readonly id: string;
  readonly label: string;
  /** Short routing rule, read after "Used for". */
  readonly usedFor: string;
  /** Only the group's admins may re-login, pause, or remove its accounts. */
  readonly adminManaged: boolean;
  readonly adminLabel?: string;
};

/**
 * Each account exits through one server so a provider never sees it hop
 * between IPs. It only reroutes while its pinned server updates.
 */
export type AccountPin = {
  readonly serverId: string;
  readonly reroutedViaServerId?: string;
};

export type PoolAccount = {
  readonly id: string;
  readonly harness: PoolHarness;
  readonly name: string;
  readonly plan: string;
  /** Plugins groups that may route to this account; one account can serve several. */
  readonly groupIds: readonly string[];
  readonly state: "active" | "paused" | "needsLogin";
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly resetCredits: ServerProviderResetCredits;
  readonly pin: AccountPin;
};

export type PoolRole = "use" | "manage";

export const POOL_ROLE_LABEL: Record<PoolRole, string> = {
  use: "Can use",
  manage: "Can manage",
};

/** Who a pool is shared with, Drive-style: people or whole groups. */
export type PoolGrant =
  | { readonly kind: "person"; readonly personId: string; readonly role: PoolRole }
  | { readonly kind: "group"; readonly groupId: string; readonly role: PoolRole };

/**
 * A named set of accounts for one harness. Pools are owned by a person (or an
 * organization's admins) and shared like a Drive file; which work may use an
 * account is still decided by its groups.
 */
export type AccountPool = {
  readonly id: string;
  readonly name: string;
  readonly harness: PoolHarness;
  readonly ownerId: string;
  /** Set when an organization's admins own the pool, e.g. "Northwind". */
  readonly orgName?: string;
  readonly accounts: readonly PoolAccount[];
  readonly grants: readonly PoolGrant[];
};

/** Pooled capacity for one harness across every pool you can use. */
export type PoolCapacity = {
  readonly harness: PoolHarness;
  readonly accounts: readonly PoolAccount[];
  readonly serving: number;
  /** Weekly allowance left in account-weeks, e.g. 1.8 of 3 accounts. */
  readonly left: number;
  readonly nextResetAt: number | null;
  readonly banked: number;
  readonly nextBankedExpiry: number | null;
};

export function weeklyWindow(account: PoolAccount) {
  return account.windows.find((entry) => entry.kind === "weekly") ?? account.windows[0];
}

/** 0-100 left in the account's weekly window. */
export function weeklyRemaining(account: PoolAccount): number {
  const window = weeklyWindow(account);
  return window ? Math.round(100 - window.usedPercent) : 0;
}

const minOf = (values: readonly number[]) => (values.length === 0 ? null : Math.min(...values));

export function poolCapacity(harness: PoolHarness, accounts: readonly PoolAccount[]): PoolCapacity {
  const members = accounts.filter((account) => account.harness === harness);
  // Paused and logged-out accounts can't serve requests, so they add no allowance.
  const serving = members.filter((account) => account.state === "active");
  return {
    harness,
    accounts: members,
    serving: serving.length,
    left: serving.reduce((sum, account) => sum + weeklyRemaining(account) / 100, 0),
    nextResetAt: minOf(
      serving.flatMap((account) => {
        const at = weeklyWindow(account)?.resetsAt;
        return at ? [Date.parse(at)] : [];
      }),
    ),
    banked: members.reduce((sum, account) => sum + account.resetCredits.availableCount, 0),
    nextBankedExpiry: minOf(
      members.flatMap((account) =>
        account.resetCredits.nextExpiresAt ? [Date.parse(account.resetCredits.nextExpiresAt)] : [],
      ),
    ),
  };
}

export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** Prototype stand-in for every action that would need the account gateway. */
export function notifyAccountsComingSoon(action: string) {
  toastManager.add({
    id: "accounts-coming-soon",
    type: "info",
    title: `${action} is coming soon`,
    description: "Accounts is a preview on placeholder data.",
    timeout: 2500,
  });
}
