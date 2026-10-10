import { ProviderDriverKind, type UsageLimitSourceAccount } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  type AccountWindowState,
  accountWindowKey,
  HOUR_MS,
  recordRead,
} from "./poolUsageRecording.ts";

const at = (time: string) => Date.parse(`2026-10-05T${time}:00.000Z`);
const hourOf = (time: string) => Math.floor(at(time) / HOUR_MS);

const account = (
  time: string,
  window: {
    readonly used: number;
    readonly resetsAt?: string;
    readonly kind?: "session" | "weekly";
  },
): UsageLimitSourceAccount => ({
  id: "claude-a.json",
  driver: ProviderDriverKind.make("claudeAgent"),
  usageLimits: {
    checkedAt: `2026-10-05T${time}:00.000Z`,
    windows: [
      {
        id: "five_hour",
        kind: window.kind ?? "session",
        label: "Session",
        usedPercent: window.used,
        ...(window.resetsAt ? { resetsAt: `2026-10-05T${window.resetsAt}:00.000Z` } : {}),
      },
    ],
  },
});

const read = (
  previous: ReadonlyArray<AccountWindowState>,
  window: Parameters<typeof account>[1],
  now: string,
) =>
  recordRead({
    previous: new Map(
      previous.map((state) => [
        accountWindowKey(state.poolId, state.accountId, state.windowId),
        state,
      ]),
    ),
    pools: [{ poolId: "team", accounts: [account(now, window)] }],
    now: at(now),
  });

const consumedByHour = (hours: ReturnType<typeof recordRead>["hours"]) =>
  Object.fromEntries(hours.map((entry) => [entry.hour, entry.consumed]));

describe("recordRead", () => {
  it("only marks the hour watched on a window's first read", () => {
    const first = read([], { used: 40, resetsAt: "14:00" }, "10:30");
    expect(first.hours).toEqual([
      {
        poolId: "team",
        driver: "claudeAgent",
        windowId: "five_hour",
        hour: hourOf("10:00"),
        consumed: 0,
      },
    ]);
    expect(first.states).toEqual([
      {
        poolId: "team",
        accountId: "claude-a.json",
        windowId: "five_hour",
        used: 40,
        resetsAt: at("14:00"),
        observedAt: at("10:30"),
      },
    ]);
  });

  it("spreads a rise over the hours between two reads", () => {
    const first = read([], { used: 10, resetsAt: "14:00" }, "10:30");
    const second = read(first.states, { used: 30, resetsAt: "14:00" }, "12:30");
    expect(consumedByHour(second.hours)).toEqual({
      [hourOf("10:00")]: 5,
      [hourOf("11:00")]: 10,
      [hourOf("12:00")]: 5,
    });
  });

  it("counts everything used since a reset once the window rolled over", () => {
    const first = read([], { used: 80, resetsAt: "11:00" }, "10:00");
    // The new five-hour window started at 11:00, so its 15% was all used after then.
    const second = read(first.states, { used: 15, resetsAt: "16:00" }, "12:00");
    expect(consumedByHour(second.hours)).toEqual({ [hourOf("11:00")]: 15 });
  });

  it("doesn't count a drop without a new reset as use", () => {
    const first = read([], { used: 80, resetsAt: "14:00" }, "10:00");
    const second = read(first.states, { used: 79, resetsAt: "14:00" }, "11:00");
    expect(consumedByHour(second.hours)).toEqual({ [hourOf("10:00")]: 0 });
  });

  it("skips a read no newer than the last one, such as a republished snapshot", () => {
    const first = read([], { used: 10, resetsAt: "14:00" }, "10:00");
    const replay = recordRead({
      previous: new Map(
        first.states.map((state) => [
          accountWindowKey(state.poolId, state.accountId, state.windowId),
          state,
        ]),
      ),
      pools: [{ poolId: "team", accounts: [account("10:00", { used: 10, resetsAt: "14:00" })] }],
      now: at("11:00"),
    });
    expect(replay).toEqual({ states: [], hours: [] });
  });

  it("skips a read whose reset has already passed", () => {
    const stale = read([], { used: 90, resetsAt: "09:00" }, "10:00");
    expect(stale.hours).toEqual([]);
    expect(stale.states).toEqual([]);
  });
});
