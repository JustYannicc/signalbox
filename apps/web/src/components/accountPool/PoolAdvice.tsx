import {
  type AccountPoolProviderAdvice,
  POOL_ADVICE_MIN_HISTORY_HOURS,
} from "@t3tools/contracts/accountHub";
import { formatDuration } from "@t3tools/shared/usageLimits";

/**
 * One provider's line of pool advice, from the server's usage history: when
 * it runs out at this pace and how many accounts would carry it, that it
 * lasts the week, or that it's still learning the pool's pace.
 */
export function PoolAdvice({
  advice,
  label,
  now,
}: {
  readonly advice: AccountPoolProviderAdvice;
  /** The provider's name, as its heading shows it. */
  readonly label: string;
  readonly now: number;
}) {
  if (advice.historyHours < POOL_ADVICE_MIN_HISTORY_HOURS) {
    return (
      <p className="text-xs text-muted-foreground">
        Learning this pool's pace: advice after a day of use.
      </p>
    );
  }
  if (!advice.runsOut) {
    return <p className="text-xs text-muted-foreground">Lasts the week at this pace.</p>;
  }
  const at = Date.parse(advice.runsOut.at);
  const backAt = advice.runsOut.backAt ? Date.parse(advice.runsOut.backAt) : null;
  return (
    <p className="text-xs text-muted-foreground">
      At this pace,{" "}
      <span className="text-foreground">
        {advice.runsOut.window} runs out {at <= now ? "now" : `in ${formatDuration(at - now)}`}
      </span>
      {backAt !== null ? ` and comes back ${formatDuration(backAt - at)} later` : ""}.
      {advice.addAccounts > 0 ? (
        <span className="text-warning-foreground">
          {" "}
          Add {advice.addAccounts} {label} {advice.addAccounts === 1 ? "account" : "accounts"} to
          keep up.
        </span>
      ) : null}
    </p>
  );
}
