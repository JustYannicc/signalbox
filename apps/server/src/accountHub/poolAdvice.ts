/**
 * Advice from a pool's usage history: when each provider runs out at the
 * current pace, and how many more accounts of it would carry the pool through
 * the next week.
 *
 * The pace is the pool's own: what it used in each hour of the week over the
 * last four weeks (nights, weekends, and the afternoon peak included), scaled
 * so the last seven days come out at what they actually used. The forecast
 * plays that pace forward over the accounts as they stand now. Load splits
 * evenly over the accounts that still have quota in every window, the way
 * CLIProxyAPI round-robins; each window fills in its own units and resets on
 * its own clock. The pool runs out when no account has quota left.
 *
 * @module accountHub/poolAdvice
 */
import type { UsageLimitSourceAccount } from "@t3tools/contracts";
import type { AccountPoolProviderAdvice } from "@t3tools/contracts/accountHub";
import * as DateTime from "effect/DateTime";

import { HOUR_MS, type UsageHour, windowDurationMs } from "./poolUsageRecording.ts";

const STEP_MS = 15 * 60_000;
const HORIZON_MS = 7 * 24 * HOUR_MS;
const PROFILE_HOURS = 28 * 24;
const RECENT_HOURS = 7 * 24;
/** Less than a day of history says nothing about the daily rhythm. */
export const MIN_HISTORY_HOURS = 24;
const MAX_ADDED_ACCOUNTS = 64;

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/**
 * Consumption per hour of one window going forward, from its history, or null
 * when there is less than {@link MIN_HISTORY_HOURS} of it. `history` holds the
 * window's watched hours; the hour under way is left out as unfinished.
 */
export function paceFrom(
  history: ReadonlyArray<Pick<UsageHour, "hour" | "consumed">>,
  nowHour: number,
): ((hour: number) => number) | null {
  const watched = history.filter(
    (entry) => entry.hour < nowHour && entry.hour >= nowHour - PROFILE_HOURS,
  );
  if (watched.length < MIN_HISTORY_HOURS) return null;
  const meanBy = (slot: (hour: number) => number) => {
    const totals = new Map<number, { sum: number; count: number }>();
    for (const entry of watched) {
      const key = slot(entry.hour);
      const total = totals.get(key) ?? { sum: 0, count: 0 };
      totals.set(key, { sum: total.sum + entry.consumed, count: total.count + 1 });
    }
    return new Map([...totals].map(([key, total]) => [key, total.sum / total.count]));
  };
  const byHourOfWeek = meanBy((hour) => hour % 168);
  const byHourOfDay = meanBy((hour) => hour % 24);
  const overall = watched.reduce((sum, entry) => sum + entry.consumed, 0) / watched.length;
  // Hours of the week not watched yet borrow the same hour of other days.
  const usual = (hour: number) =>
    byHourOfWeek.get(hour % 168) ?? byHourOfDay.get(hour % 24) ?? overall;
  const lastWeek = watched.filter((entry) => entry.hour >= nowHour - RECENT_HOURS);
  const expected = lastWeek.reduce((sum, entry) => sum + usual(entry.hour), 0);
  const actual = lastWeek.reduce((sum, entry) => sum + entry.consumed, 0);
  const scale = expected > 0 ? actual / expected : 1;
  return (hour) => usual(hour) * scale;
}

export interface ForecastWindow {
  readonly id: string;
  readonly label: string;
  readonly durationMs: number | null;
  /** Share of one account's window used per hour; null when this window has no history. */
  readonly pace: ((hour: number) => number) | null;
}

interface SimWindow {
  used: number;
  resetsAt: number | null;
}

/** An account as the forecast sees it: its windows by id. */
export type ForecastAccount = ReadonlyMap<
  string,
  { readonly used: number; readonly resetsAt: number | null }
>;

/**
 * When no account has quota left within the next week, with the window that
 * shut the last one and when a reset next hands an account back; null if the
 * accounts last the week.
 */
export function forecastRunOut(
  windows: ReadonlyArray<ForecastWindow>,
  accounts: ReadonlyArray<ForecastAccount>,
  now: number,
): { readonly at: number; readonly window: string; readonly backAt: number | null } | null {
  const state = accounts.map((account) =>
    windows.map((window): SimWindow => {
      const current = account.get(window.id);
      return { used: current?.used ?? 0, resetsAt: current?.resetsAt ?? null };
    }),
  );
  const isOpen = (account: SimWindow[]) => account.every((window) => window.used < 100);
  for (let at = now; at < now + HORIZON_MS; at += STEP_MS) {
    for (const account of state) {
      account.forEach((window, index) => {
        const duration = windows[index]!.durationMs;
        while (window.resetsAt !== null && window.resetsAt <= at) {
          window.used = 0;
          window.resetsAt = duration === null ? null : window.resetsAt + duration;
        }
      });
    }
    const open = state.filter(isOpen);
    if (open.length === 0) {
      const reopens = state.map((account) =>
        Math.max(
          ...account
            .filter((window) => window.used >= 100)
            .map((window) => window.resetsAt ?? Number.POSITIVE_INFINITY),
        ),
      );
      const backAt = Math.min(...reopens);
      // The window full on the most accounts is the one that ran the pool dry.
      const full = windows.map(
        (_, index) => state.filter((account) => account[index]!.used >= 100).length,
      );
      const window = windows[full.indexOf(Math.max(...full))]?.label ?? "";
      return { at, window, backAt: Number.isFinite(backAt) ? backAt : null };
    }
    const hour = Math.floor(at / HOUR_MS);
    for (const account of open) {
      account.forEach((window, index) => {
        const { pace, durationMs } = windows[index]!;
        const load = ((pace?.(hour) ?? 0) * STEP_MS) / HOUR_MS / open.length;
        if (load <= 0) return;
        // An untouched window starts its clock on first use.
        if (window.resetsAt === null && durationMs !== null) window.resetsAt = at + durationMs;
        window.used = Math.min(100, window.used + load);
      });
    }
  }
  return null;
}

/** Fresh accounts to add before `accounts` last the week; monotone, so a binary search. */
function accountsToAdd(
  windows: ReadonlyArray<ForecastWindow>,
  accounts: ReadonlyArray<ForecastAccount>,
  now: number,
): number {
  const lasts = (added: number) =>
    forecastRunOut(
      windows,
      [...accounts, ...Array.from({ length: added }, () => new Map())],
      now,
    ) === null;
  if (lasts(0)) return 0;
  if (!lasts(MAX_ADDED_ACCOUNTS)) return MAX_ADDED_ACCOUNTS;
  let low = 0;
  let high = MAX_ADDED_ACCOUNTS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (lasts(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * Advice for each provider a pool holds accounts of. `accounts` are the
 * pool's accounts that take turns now; `history` its watched hours.
 */
export function advisePool(input: {
  readonly accounts: ReadonlyArray<UsageLimitSourceAccount>;
  readonly history: ReadonlyArray<Omit<UsageHour, "poolId">>;
  readonly now: number;
}): ReadonlyArray<AccountPoolProviderAdvice> {
  const { now } = input;
  const nowHour = Math.floor(now / HOUR_MS);
  const drivers = [...new Set(input.accounts.map((account) => account.driver))];
  return drivers.flatMap((driver) => {
    const own = input.accounts.filter((account) => account.driver === driver);
    const reported = new Map(
      own.flatMap((account) => account.usageLimits.windows).map((window) => [window.id, window]),
    );
    // API keys and accounts that report no windows have nothing to forecast.
    if (reported.size === 0) return [];
    const history = input.history.filter((entry) => entry.driver === driver);
    const windows = [...reported.values()].map((window): ForecastWindow => ({
      id: window.id,
      label: window.label,
      durationMs: windowDurationMs(window),
      pace: paceFrom(
        history.filter((entry) => entry.windowId === window.id),
        nowHour,
      ),
    }));
    const historyHours = Math.max(
      0,
      ...windows.map(
        (window) =>
          history.filter(
            (entry) =>
              entry.windowId === window.id &&
              entry.hour < nowHour &&
              entry.hour >= nowHour - PROFILE_HOURS,
          ).length,
      ),
    );
    if (windows.every((window) => window.pace === null)) {
      return [{ driver, historyHours, addAccounts: 0 }];
    }
    const accounts = own.map(
      (account): ForecastAccount =>
        new Map(
          account.usageLimits.windows.map((window) => {
            const parsed = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
            const resetsAt = Number.isFinite(parsed) ? parsed : null;
            // A reset already past has handed the window back.
            return resetsAt !== null && resetsAt <= now
              ? [window.id, { used: 0, resetsAt: null }]
              : [window.id, { used: window.usedPercent, resetsAt }];
          }),
        ),
    );
    const runsOut = forecastRunOut(windows, accounts, now);
    return [
      {
        driver,
        historyHours,
        ...(runsOut
          ? {
              runsOut: {
                at: iso(runsOut.at),
                window: runsOut.window,
                ...(runsOut.backAt === null ? {} : { backAt: iso(runsOut.backAt) }),
              },
            }
          : {}),
        addAccounts: runsOut ? accountsToAdd(windows, accounts, now) : 0,
      },
    ];
  });
}
