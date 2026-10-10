import { ProviderDriverKind, type UsageLimitSourceAccount } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { advisePool, paceFrom } from "./poolAdvice.ts";
import { HOUR_MS } from "./poolUsageRecording.ts";

const DAY_MS = 24 * HOUR_MS;
// A Monday, 08:00 UTC.
const NOW = Date.parse("2026-10-05T08:00:00.000Z");
const NOW_HOUR = NOW / HOUR_MS;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const claude = (
  id: string,
  window: {
    readonly id: string;
    readonly kind: "session" | "weekly";
    readonly used: number;
    readonly resetsAt?: number;
  },
): UsageLimitSourceAccount => ({
  id,
  driver: ProviderDriverKind.make("claudeAgent"),
  usageLimits: {
    checkedAt: iso(NOW),
    windows: [
      {
        id: window.id,
        kind: window.kind,
        label: window.kind === "weekly" ? "Weekly" : "Session",
        usedPercent: window.used,
        ...(window.resetsAt === undefined ? {} : { resetsAt: iso(window.resetsAt) }),
      },
    ],
  },
});

/** `hours` watched hours before now, each using what `pace` says for it. */
const history = (windowId: string, hours: number, pace: (hour: number) => number) =>
  Array.from({ length: hours }, (_, index) => {
    const hour = NOW_HOUR - hours + index;
    return { driver: "claudeAgent", windowId, hour, consumed: pace(hour) };
  });

describe("paceFrom", () => {
  it("needs a day of history", () => {
    expect(
      paceFrom(
        history("weekly", 23, () => 1),
        NOW_HOUR,
      ),
    ).toBeNull();
    expect(
      paceFrom(
        history("weekly", 24, () => 1),
        NOW_HOUR,
      ),
    ).not.toBeNull();
  });

  it("keeps the weekly rhythm at the last seven days' level", () => {
    // Three quiet weeks at 1%/h, then a week at 2%/h.
    const pace = paceFrom(
      history("weekly", 28 * 24, (hour) => (hour >= NOW_HOUR - 7 * 24 ? 2 : 1)),
      NOW_HOUR,
    );
    expect(pace?.(NOW_HOUR + 5)).toBeCloseTo(2);
  });
});

describe("advisePool", () => {
  it("has no forecast before a day of history", () => {
    const advice = advisePool({
      accounts: [
        claude("a", { id: "seven_day", kind: "weekly", used: 50, resetsAt: NOW + 6 * DAY_MS }),
      ],
      history: history("seven_day", 10, () => 2),
      now: NOW,
    });
    expect(advice).toEqual([{ driver: "claudeAgent", historyHours: 10, addAccounts: 0 }]);
  });

  it("says when a steady pace empties the pool and how many accounts carry it", () => {
    const resetsAt = NOW + 6 * DAY_MS;
    const advice = advisePool({
      accounts: [claude("a", { id: "seven_day", kind: "weekly", used: 50, resetsAt })],
      history: history("seven_day", 48, () => 2),
      now: NOW,
    });
    // 50% left at 2%/h lasts 25 hours. The week to come uses 288% before
    // the account resets on day six: three more accounts hold 350%.
    expect(advice).toEqual([
      {
        driver: "claudeAgent",
        historyHours: 48,
        runsOut: {
          at: iso(NOW + 25 * HOUR_MS),
          window: "Weekly",
          backAt: iso(resetsAt),
        },
        addAccounts: 3,
      },
    ]);
  });

  it("follows the daily rhythm into the afternoon peak", () => {
    // 25% of a session an hour from 09:00 to 17:00 UTC, nothing otherwise.
    const workHours = (hour: number) => (hour % 24 >= 9 && hour % 24 < 17 ? 25 : 0);
    const advice = advisePool({
      accounts: [claude("a", { id: "five_hour", kind: "session", used: 0 })],
      history: history("five_hour", 3 * 24, workHours),
      now: NOW,
    });
    // The session opens at 09:00 and is spent by 13:00; it resets at 14:00.
    expect(advice[0]?.runsOut).toEqual({
      at: "2026-10-05T13:00:00.000Z",
      window: "Session",
      backAt: "2026-10-05T14:00:00.000Z",
    });
    expect(advice[0]?.addAccounts).toBe(1);
  });

  it("says nothing runs out when the pool keeps up", () => {
    const advice = advisePool({
      accounts: [
        claude("a", { id: "seven_day", kind: "weekly", used: 10, resetsAt: NOW + 3 * DAY_MS }),
        claude("b", { id: "seven_day", kind: "weekly", used: 20, resetsAt: NOW + 4 * DAY_MS }),
      ],
      history: history("seven_day", 7 * 24, () => 0.5),
      now: NOW,
    });
    expect(advice).toEqual([{ driver: "claudeAgent", historyHours: 168, addAccounts: 0 }]);
  });
});
