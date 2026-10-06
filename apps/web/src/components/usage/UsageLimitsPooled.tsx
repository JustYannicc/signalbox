import { AddHubAccountMenu } from "../accountHub/AddHubAccountMenu"; // signalbox
import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
  summarizeLimitPool,
} from "@t3tools/shared/usageLimits";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { barColor } from "./UsageLimits";
import { UsageLimitsAccountList } from "./UsageLimitsAccountList";
import { LimitSegment } from "./UsageLimitsSegment";

/**
 * One pooled window as equal-width segments, one per account, each filled by
 * the share of that account's quota still open. Equal widths are honest: every
 * account contributes the same share of the pool, whatever its plan.
 */
function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
    >
      {pool.columns.map((member, position) =>
        member.window ? (
          <LimitSegment
            key={member.account.key}
            account={member.account}
            window={member.window}
            reset={restores.get(member.account.key)}
            color={color}
            now={now}
            variant="strip"
            style={{ gridColumn: position + 1 }}
          />
        ) : null,
      )}
    </div>
  );
}

/** The pooled percentage and its per-account bar for one window. */
function PoolWindowSummary({
  pool,
  color,
  now,
  label,
  description,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {label ?? pool.label}
        </span>
        <span className="text-2xl font-semibold text-foreground tabular-nums">
          {pool.remainingPercent}%
        </span>
      </div>
      <PoolBar pool={pool} color={color} now={now} />
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function PoolSection({
  pool,
  now,
  index,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly index: number;
}) {
  const color = barColor(pool.driver);
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const summary = summarizeLimitPool(pool);
  const resetWindowDetails = summary.nextReset
    ? pool.driver === "cursor"
      ? cursorUsageWindowDetails(summary.nextReset.window.id)
      : undefined
    : undefined;
  const nextResetWindowLabel = resetWindowDetails?.label ?? summary.nextReset?.window.label;
  const columnClass = cn(
    "min-w-0 border-b border-border/60 py-6 last:border-b-0 first:pt-0 last:pb-0 md:border-b-0 md:py-0",
    index % 2 === 1 && "md:border-s md:border-border md:ps-6",
    index % 2 === 0 && "md:pe-6",
    index % 3 === 0 && "xl:border-s-0 xl:ps-0 xl:pe-6",
    index % 3 === 1 && "xl:border-s xl:border-border xl:ps-6 xl:pe-6",
    index % 3 === 2 && "xl:border-s xl:border-border xl:ps-6 xl:pe-0",
  );
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", columnClass)}>
      <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
          {pool.accounts.length} {pool.accounts.length === 1 ? "account" : "accounts"}
        </span>
      </h2>
      {windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No limits reported.</p>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-4">
            {windows.map((window, windowIndex) => {
              const details =
                pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
              return (
                <div
                  key={`${window.kind}:${window.id}`}
                  className={cn(windowIndex > 0 && "border-t border-border/60 pt-4")}
                >
                  <PoolWindowSummary
                    pool={window}
                    color={color}
                    now={now}
                    label={details?.label}
                    description={details?.description}
                  />
                </div>
              );
            })}
          </div>
          <dl className="flex flex-col gap-1 border-t border-border/60 pt-3 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">Next reset</dt>
              <dd className="min-w-0 text-end text-foreground tabular-nums">
                {summary.nextReset
                  ? `${summary.nextReset.at <= now ? "now" : formatDuration(summary.nextReset.at - now)} · +${summary.nextReset.restoresPercent}%${windows.length > 1 ? ` ${nextResetWindowLabel}` : ""}`
                  : "—"}
              </dd>
            </div>
            {summary.bankedResets.availableCount > 0 ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">Banked resets</dt>
                <dd className="min-w-0 text-end text-foreground tabular-nums">
                  {summary.bankedResets.availableCount}
                  {summary.bankedResets.nextExpiresAt
                    ? ` · first expires in ${formatDuration(Date.parse(summary.bankedResets.nextExpiresAt) - now)}`
                    : ""}
                </dd>
              </div>
            ) : null}
          </dl>
        </>
      )}
    </section>
  );
}

function PoolSummary({
  pools,
  now,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  if (pools.length === 0) return null;
  return (
    <section
      aria-label="Provider limits summary"
      className="grid min-w-0 grid-cols-1 gap-y-0 border-b border-border pb-6 md:grid-cols-2 md:gap-y-6 xl:grid-cols-3"
    >
      {pools.map((pool, index) => (
        <PoolSection key={pool.driver} pool={pool} now={now} index={index} />
      ))}
    </section>
  );
}

/** Provider summary first; the account rows below it show each underlying allowance. */
export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      <PoolSummary pools={pools} now={now} />
      {cursorPrompt}
      <UsageLimitsAccountList
        pools={pools}
        now={now}
        // signalbox: accounts are added to the account hub from here.
        actions={<AddHubAccountMenu environmentIds={[...presentations.keys()]} />}
      />
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

/** Sources and providers that could not be read, so a missing bar is not mistaken for a full one. */
function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
