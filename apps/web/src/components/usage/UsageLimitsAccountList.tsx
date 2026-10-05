import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
} from "@t3tools/shared/usageLimits";

import { AccountAvatar } from "./UsageLimitsAccountIdentity";
import { getDriverOption } from "../settings/providerDriverMeta";
import { LimitWindows, ResetCredits, resetCreditsSummary } from "./UsageLimits";

function AccountRow({
  account,
  pool,
  now,
}: {
  readonly account: LimitAccount;
  readonly pool: LimitPool;
  readonly now: number;
}) {
  const providerLabel = getDriverOption(account.driver)?.label ?? String(account.driver);
  const windows = displayLimitWindows(pool).flatMap((window) => {
    const member = window.members.find((candidate) => candidate.account.key === account.key);
    return member ? [member.window] : [];
  });
  const location =
    account.environments.length > 0
      ? `On ${account.environments.map((environment) => environment.label).join(", ")}`
      : account.sourceLabel
        ? `From ${account.sourceLabel}`
        : null;
  const credits = account.limits.resetCredits;

  return (
    <li className="grid min-w-0 gap-3 py-3 xl:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)_minmax(12rem,auto)] xl:items-center">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <AccountAvatar account={account} />
          <span className="truncate text-sm font-medium text-foreground">
            {account.displayName ?? account.email ?? providerLabel}
          </span>
        </div>
        {account.displayName && account.email ? (
          <span className="truncate text-xs text-muted-foreground">{account.email}</span>
        ) : null}
        <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{providerLabel}</span>
          {account.plan ? <span>{account.plan}</span> : null}
        </span>
        {location ? (
          <span className="truncate text-xs text-muted-foreground">{location}</span>
        ) : null}
      </div>

      <LimitWindows driver={pool.driver} windows={windows} now={now} compact />

      <div
        data-slot="account-actions"
        className="flex min-w-0 items-center justify-between gap-3 xl:justify-end"
      >
        {account.redeem && credits?.availableCount ? (
          <ResetCredits
            environmentId={account.redeem.environmentId}
            input={account.redeem.input}
            credits={credits}
            now={now}
          />
        ) : (
          <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
            {credits?.availableCount ? resetCreditsSummary(credits, now, true) : "No resets banked"}
          </span>
        )}
      </div>
    </li>
  );
}

/** Rows follow the same provider and reset ordering as their summary columns. */
export function UsageLimitsAccountList({
  pools,
  now,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  if (pools.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Accounts">
      <h2 className="text-sm font-medium text-foreground">Accounts</h2>
      {pools.map((pool) => {
        const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
        return (
          <section key={pool.driver} aria-label={`${label} accounts`} className="min-w-0">
            <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>{label}</span>
              <span className="tabular-nums">
                {pool.accounts.length} {pool.accounts.length === 1 ? "account" : "accounts"}
              </span>
            </h3>
            <ul className="divide-y divide-border/60 border-y border-border/60">
              {pool.accounts.map((account) => (
                <AccountRow key={account.key} account={account} pool={pool} now={now} />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
