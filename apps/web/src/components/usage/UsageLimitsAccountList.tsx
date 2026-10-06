import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  limitsNotice,
} from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";

import { HubAccountActions } from "../accountHub/HubAccountActions";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { barColor, ResetCreditDialog, useResetCredit } from "./UsageLimits";
import { LimitSegment } from "./UsageLimitsSegment";

/** "Use reset" for an account whose banked credit can be redeemed here; the count is on its bar. */
function UseReset({ account }: { readonly account: LimitAccount }) {
  const redeemAt = account.redeem;
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  if (!redeemAt || credits === 0) return null;
  return <UseResetButton redeemAt={redeemAt} />;
}

function UseResetButton({ redeemAt }: { readonly redeemAt: NonNullable<LimitAccount["redeem"]> }) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={redeem.busy}
        title={redeem.status ?? undefined}
        onClick={() => redeem.setConfirming(true)}
      >
        {redeem.busy ? "Using…" : "Use reset"}
      </Button>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
      />
    </>
  );
}

/**
 * One account: its email and plan, then T3 Code's segment for each window it
 * reports. Where it is signed in and reset times live in the segment popover.
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
  const signedOut = notice?.startsWith("Signed out") === true;

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
            <Badge variant="warning" size="sm">
              Signed out
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
        <UseReset account={account} />
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
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  /** Shown beside the heading, even before there are accounts. */
  readonly actions?: ReactNode;
}) {
  if (pools.length === 0 && !actions) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Accounts">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Accounts</h2>
        {actions}
      </div>
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
