import {
  formatResetsIn,
  type LimitAccount,
  type LimitPoolMember,
  type LimitPoolWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { windowRedeem, windowResetCredits } from "@t3tools/shared/usageLimitWindows";
import { TicketIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { getDriverOption } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ResetCreditDialog, resetCreditsSummary, useResetCredit } from "./UsageLimits";
import { AccountAvatar, AccountName, accountInitials } from "./UsageLimitsAccountIdentity";

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Everything about one account in one window: plan, where it is signed in,
 * the email on request, reset time and share of the pool it restores, and the
 * reset-credit action. Opens on hover for a glance, on click to act.
 */
function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  /** Redeem state owned by the segment, since the confirm lives outside this popover. */
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const windowCredits = windowResetCredits(account, window.id);
  const credits = redeem && windowCredits?.availableCount ? windowCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? getDriverOption(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">+{reset.restoresPercent}% of pool</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
            <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={redeem.busy || !redeem.canManageProviders}
              className="ms-auto"
              onClick={onRedeem}
            >
              {redeem.busy ? "Using…" : "Use reset"}
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * T3 Code's limit segment: one account in one window, filled by the share
 * still open, with the spent share hatched when a reset will restore it.
 * `strip` is the slim, unlabelled form for pooled bars; `labelled` carries the
 * window, percentage, countdown, and banked credits inline. Both open the same
 * popover with the account's details and the reset-credit action.
 */
export function LimitSegment({
  account,
  window,
  reset,
  color,
  now,
  variant,
  label,
  style,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly color: string;
  readonly now: number;
  readonly variant: "strip" | "labelled";
  /** Leading text in the labelled form, such as the window name. */
  readonly label?: ReactNode;
  readonly style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const credits = windowResetCredits(account, window.id)?.availableCount ?? 0;
  const redeemAt = windowRedeem(account, window.id);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        render={
          <button
            type="button"
            style={style}
            aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : account.driver)} · ${window.label}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${credits ? `, ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : ""}`}
            className={cn(
              "relative min-w-0 cursor-pointer overflow-hidden bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-border",
              variant === "strip" ? "h-2.5 rounded-full" : "h-8 rounded-md",
            )}
          />
        }
      >
        {/* Translucent so the label reads over the fill for any provider colour and theme. */}
        <div
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0",
            variant === "strip" ? "rounded-full opacity-70" : "rounded-md opacity-35",
          )}
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
        {/* The spent share is hatched, not blank: it is what the countdown restores. */}
        {remaining < 100 && reset ? (
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 opacity-20"
            style={{
              width: `${100 - remaining}%`,
              backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
            }}
          />
        ) : null}
        {variant === "labelled" ? (
          <div className="relative flex h-full min-w-0 items-center gap-1.5 px-2 text-xs">
            {label ? <span className="min-w-0 truncate text-muted-foreground">{label}</span> : null}
            <span className="shrink-0 font-semibold text-foreground tabular-nums">
              {remaining}%
            </span>
            {/* Countdown and badge get their own plate: fill and hatching run under them otherwise. */}
            {resetsIn || credits ? (
              <span className="ms-auto flex shrink-0 items-center gap-1.5 rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs text-foreground tabular-nums">
                {resetsIn?.replace("resets in ", "↻ ") ?? ""}
                {credits ? (
                  <>
                    {resetsIn ? (
                      <span aria-hidden className="text-muted-foreground">
                        ·
                      </span>
                    ) : null}
                    <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold">
                      <TicketIcon className="size-3" aria-hidden />
                      {credits}
                    </span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}
      </PopoverTrigger>
      {redeemAt ? (
        <RedeemableSegmentPopup
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeemAt={redeemAt}
          closePopover={() => setOpen(false)}
        />
      ) : (
        <PopoverPopup side="top" sideOffset={6}>
          <SegmentPopover
            account={account}
            window={window}
            reset={reset}
            now={now}
            redeem={null}
            onRedeem={() => {}}
          />
        </PopoverPopup>
      )}
    </Popover>
  );
}

/** Split out so the redeem hook only runs for accounts that can redeem. */
function RedeemableSegmentPopup({
  account,
  window,
  reset,
  now,
  redeemAt,
  closePopover,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
  readonly closePopover: () => void;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <PopoverPopup side="top" sideOffset={6}>
        <SegmentPopover
          account={account}
          window={window}
          reset={reset}
          now={now}
          redeem={redeem}
          onRedeem={() => {
            closePopover();
            redeem.setConfirming(true);
          }}
        />
      </PopoverPopup>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so the outcome needs a home outside it. */}
      {redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={account} className="font-medium text-foreground" /> {redeem.status}
        </span>
      ) : null}
    </>
  );
}
