/**
 * Turns successive reads of a pool's accounts into hourly consumption. A
 * window's `usedPercent` only says how full it is now, so what a pool used is
 * the rise between two reads of the same account, or everything used since a
 * reset when the window rolled over in between. That rise is spread evenly
 * over the hours between the reads, so a gap (no client polling, the server
 * off) neither loses use nor piles it onto one hour.
 *
 * Units are share of one account's window: 100 is one account's whole
 * weekly (or session) allowance, summed over the pool's accounts.
 *
 * @module accountHub/poolUsageRecording
 */
import type { ServerProviderUsageWindow, UsageLimitSourceAccount } from "@t3tools/contracts";

export const HOUR_MS = 3_600_000;
/** Providers recompute a window's reset time on every read; a minute either way is the same reset. */
const RESET_JITTER_MS = 60_000;

const DEFAULT_WINDOW_MINUTES: Partial<Record<ServerProviderUsageWindow["kind"], number>> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
};

/** How long a window runs before it resets, or null when the provider gives no way to know. */
export const windowDurationMs = (window: ServerProviderUsageWindow): number | null => {
  const minutes = window.windowDurationMins ?? DEFAULT_WINDOW_MINUTES[window.kind];
  return minutes ? minutes * 60_000 : null;
};

/** One account window as last read. */
export interface AccountWindowState {
  readonly poolId: string;
  readonly accountId: string;
  readonly windowId: string;
  readonly used: number;
  readonly resetsAt: number | null;
  readonly observedAt: number;
}

/** What a pool used of one provider window in one hour (`hour` counts hours since the epoch). */
export interface UsageHour {
  readonly poolId: string;
  readonly driver: string;
  readonly windowId: string;
  readonly hour: number;
  readonly consumed: number;
}

export const accountWindowKey = (poolId: string, accountId: string, windowId: string) =>
  JSON.stringify([poolId, accountId, windowId]);

const hourKey = (poolId: string, driver: string, windowId: string, hour: number) =>
  JSON.stringify([poolId, driver, windowId, hour]);

/**
 * The hours a read of `accounts` adds to each pool's history, and the account
 * windows to remember for the next read. `previous` is keyed by
 * {@link accountWindowKey}. The first read of a window only marks the hour as
 * watched: what it used before is unknown.
 */
export function recordRead(input: {
  readonly previous: ReadonlyMap<string, AccountWindowState>;
  readonly pools: ReadonlyArray<{
    readonly poolId: string;
    readonly accounts: ReadonlyArray<UsageLimitSourceAccount>;
  }>;
  readonly now: number;
}): {
  readonly states: ReadonlyArray<AccountWindowState>;
  readonly hours: ReadonlyArray<UsageHour>;
} {
  const { now } = input;
  const states: AccountWindowState[] = [];
  const hours = new Map<string, UsageHour>();
  const add = (
    poolId: string,
    driver: string,
    windowId: string,
    hour: number,
    consumed: number,
  ) => {
    const key = hourKey(poolId, driver, windowId, hour);
    const current = hours.get(key);
    hours.set(key, {
      poolId,
      driver,
      windowId,
      hour,
      consumed: (current?.consumed ?? 0) + consumed,
    });
  };
  /** `consumed` spread over [from, to] in proportion to each hour's overlap. */
  const spread = (
    poolId: string,
    driver: string,
    windowId: string,
    consumed: number,
    from: number,
    to: number,
  ) => {
    const start = Math.min(from, to);
    const span = to - start;
    for (let hour = Math.floor(start / HOUR_MS); hour <= Math.floor(to / HOUR_MS); hour++) {
      const overlap = Math.min(to, (hour + 1) * HOUR_MS) - Math.max(start, hour * HOUR_MS);
      if (span === 0) add(poolId, driver, windowId, hour, consumed);
      else if (overlap > 0) add(poolId, driver, windowId, hour, (consumed * overlap) / span);
    }
  };

  for (const { poolId, accounts } of input.pools) {
    for (const account of accounts) {
      // When the account was actually read: a cached or republished read keeps its old time.
      const checkedAt = Date.parse(account.usageLimits.checkedAt);
      const observedAt = Number.isFinite(checkedAt) ? Math.min(checkedAt, now) : now;
      for (const window of account.usageLimits.windows) {
        const parsed = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
        const resetsAt = Number.isFinite(parsed) ? parsed : null;
        // A reset already past means this read is older than the window; skip it.
        if (resetsAt !== null && resetsAt <= observedAt) continue;
        const before = input.previous.get(accountWindowKey(poolId, account.id, window.id));
        // Nothing new since the last time this window was recorded.
        if (before && observedAt <= before.observedAt) continue;
        const used = window.usedPercent;
        states.push({
          poolId,
          accountId: account.id,
          windowId: window.id,
          used,
          resetsAt,
          observedAt,
        });
        if (!before) {
          add(poolId, account.driver, window.id, Math.floor(observedAt / HOUR_MS), 0);
          continue;
        }
        const resetSince = before.resetsAt !== null && before.resetsAt <= observedAt;
        // A drop with a later reset is a fresh window (a redeemed reset); a drop
        // without one is the provider recounting, not use.
        const restarted =
          used < before.used &&
          resetsAt !== null &&
          (before.resetsAt === null || resetsAt > before.resetsAt + RESET_JITTER_MS);
        if (!resetSince && !restarted) {
          const rise = Math.max(0, used - before.used);
          spread(poolId, account.driver, window.id, rise, before.observedAt, observedAt);
          continue;
        }
        // Rolled over: all of `used` came after the reset, and nothing before it is known.
        const duration = windowDurationMs(window);
        const from = Math.max(
          before.observedAt,
          resetSince ? before.resetsAt! : before.observedAt,
          resetsAt !== null && duration !== null ? resetsAt - duration : before.observedAt,
        );
        spread(poolId, account.driver, window.id, used, from, observedAt);
      }
    }
  }
  return { states, hours: [...hours.values()] };
}
