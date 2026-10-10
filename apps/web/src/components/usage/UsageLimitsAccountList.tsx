import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  limitsNotice,
} from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";

import { HubAccountActions } from "../accountHub/HubAccountActions";
import { SignInAgainButton } from "../accountHub/SignInAgainButton";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { barColor } from "./UsageLimits";
import { LimitSegment } from "./UsageLimitsSegment";

/**
 * One account: its email and plan, then T3 Code's segment for each window it
 * reports. Where it is signed in, reset times, and "Use reset" live in the
 * segment popover.
 */
function AccountRow({
  account,
  pool,
  now,
}: {
  readonly account: LimitAccount;
  readonly pool: LimitPool;
  readonly now: number;
}) {
  const color = barColor(pool.driver);
  const windows = displayLimitWindows(pool).flatMap((poolWindow) => {
    const member = poolWindow.members.find((candidate) => candidate.account.key === account.key);
    if (!member) return [];
    const reset = poolWindow.resets.find((entry) => entry.member.account.key === account.key);
    return [{ poolWindow, window: member.window, reset }];
  });
  const notice = windows.length === 0 ? limitsNotice(account.limits) : null;
  const signedOut = account.hubAccount?.signedOut === true;

  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-2.5 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">
          {account.email ?? account.displayName ?? getDriverOption(account.driver)?.label}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {account.plan ? <span className="truncate">{account.plan}</span> : null}
          {account.hubAccount?.disabled ? (
            <Badge variant="secondary" size="sm">
              Paused
            </Badge>
          ) : null}
          {signedOut ? (
            // A native login of the same account can still work; the hub's copy cannot.
            <Badge variant="error" size="sm">
              {windows.length > 0 ? "Signed out in hub" : "Signed out"}
            </Badge>
          ) : null}
        </span>
      </div>
      <div className="col-span-2 row-start-2 grid min-w-0 auto-cols-fr grid-flow-col gap-1 md:col-span-1 md:row-start-auto">
        {windows.length > 0 ? (
          windows.map(({ poolWindow, window, reset }) => (
            <LimitSegment
              key={`${window.kind}:${window.id}`}
              account={account}
              window={window}
              reset={reset}
              color={color}
              now={now}
              variant="labelled"
              label={poolWindow.label}
            />
          ))
        ) : account.hubAccount?.disabled || signedOut ? null : (
          <span className="truncate text-xs text-muted-foreground">
            {notice ?? "No limits reported."}
          </span>
        )}
      </div>
      <span className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 md:col-start-auto md:row-start-auto">
        <SignInAgainButton account={account} />
        <HubAccountActions account={account} />
      </span>
    </li>
  );
}

/** Rows follow the same provider and reset ordering as their summary columns. */
export function UsageLimitsAccountList({
  pools,
  now,
  actions,
  title = "Accounts",
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  /** Shown beside the heading, even before there are accounts. */
  readonly actions?: ReactNode;
  /** The account pool's name when the list shows one pool. */
  readonly title?: string;
}) {
  if (pools.length === 0 && !actions) return null;
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex items-center justify-between gap-3">
        {/* A pool's name sits a level above its providers. */}
        <h2
          className={
            title === "Accounts"
              ? "text-sm font-medium text-foreground"
              : "text-base font-semibold text-foreground"
          }
        >
          {title}
        </h2>
        {actions}
      </div>
      {pools.length === 0 ? (
        <p className="text-xs text-muted-foreground">No accounts yet.</p>
      ) : null}
      {pools.map((pool) => {
        const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
        return (
          <section key={pool.driver} aria-label={`${label} accounts`} className="min-w-0">
            <h3 className="mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground">
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={label}
                indicatorBackground="var(--background)"
                className="size-5"
                iconClassName="size-4 text-foreground/80"
              />
              {label}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
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
