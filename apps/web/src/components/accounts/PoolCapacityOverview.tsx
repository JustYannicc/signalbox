import { formatDuration } from "@t3tools/shared/usageLimits";

import { cn } from "../../lib/utils";
import { POOL_LABEL, plural, weeklyRemaining, type PoolCapacity } from "./accountPoolsModel";
import { PoolMark, poolColor } from "./accountPoolsPrimitives";

/**
 * Pooled capacity per harness across every pool you can use: allowance left
 * in account-weeks, one bar segment per account, next reset, banked resets.
 */
export function PoolCapacityOverview({
  capacities,
  now,
}: {
  readonly capacities: readonly PoolCapacity[];
  readonly now: number;
}) {
  return (
    <section
      aria-label="Pooled capacity"
      className="grid gap-6 border-b border-border pb-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border"
    >
      {capacities.map((capacity) => (
        <CapacityColumn key={capacity.harness} capacity={capacity} now={now} />
      ))}
    </section>
  );
}

function CapacityColumn({
  capacity,
  now,
}: {
  readonly capacity: PoolCapacity;
  readonly now: number;
}) {
  const color = poolColor(capacity.harness);
  const notServing = capacity.accounts.length - capacity.serving;
  return (
    <div className="flex min-w-0 flex-col gap-3 md:px-6 md:first:ps-0 md:last:pe-0">
      <div className="flex items-center gap-2">
        <PoolMark harness={capacity.harness} className="size-4" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {POOL_LABEL[capacity.harness]}
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {plural(capacity.accounts.length, "account")}
          {notServing > 0 ? ` · ${notServing} off` : ""}
        </span>
      </div>

      <p className="flex flex-col">
        <span className="text-3xl font-semibold text-foreground tabular-nums">
          {capacity.left.toFixed(1)}
          <span className="text-base font-normal text-muted-foreground">
            {" "}
            of {capacity.serving}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">accounts' weekly allowance left</span>
      </p>

      <div className="flex gap-1">
        {capacity.accounts.map((account) => {
          const remaining = weeklyRemaining(account);
          const serving = account.state === "active";
          return (
            <div
              key={account.id}
              role="img"
              aria-label={`${account.name}: ${remaining}% left${serving ? "" : " (not serving)"}`}
              className={cn(
                "relative h-1.5 min-w-0 flex-1 rounded-full bg-muted",
                !serving && "opacity-40",
              )}
            >
              {remaining > 0 ? (
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${remaining}%`, backgroundColor: color }}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <dl className="flex flex-col gap-1 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Next reset</dt>
          <dd className="text-foreground tabular-nums">
            {capacity.nextResetAt === null
              ? "—"
              : `in ${formatDuration(capacity.nextResetAt - now)}`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Banked resets</dt>
          <dd className="text-end text-foreground tabular-nums">
            {capacity.banked}
            {capacity.nextBankedExpiry !== null ? (
              <span className="text-muted-foreground">
                {" "}
                · next expires in {formatDuration(capacity.nextBankedExpiry - now)}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
    </div>
  );
}
