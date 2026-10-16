import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_BROWSER_IDLE_AFTER_MS,
  agentBrowserWatchLease,
  createAgentBrowserLease,
} from "./signalboxAgentBrowserLease.ts";

describe("agentBrowserWatchLease", () => {
  const now = 1_000_000;

  it("watches while the panel shows, the app is in front, and the person is around", () => {
    expect(
      agentBrowserWatchLease({
        panelVisible: true,
        appVisible: true,
        now,
        lastActiveAt: now - 1000,
      }),
    ).toEqual({ watching: true, recheckInMs: AGENT_BROWSER_IDLE_AFTER_MS - 1000 });
  });

  it("lets go when nobody can see it or the person went idle", () => {
    const lastActiveAt = now - 1000;
    expect(
      agentBrowserWatchLease({ panelVisible: false, appVisible: true, now, lastActiveAt }),
    ).toEqual({ watching: false, recheckInMs: null });
    expect(
      agentBrowserWatchLease({ panelVisible: true, appVisible: false, now, lastActiveAt }),
    ).toEqual({ watching: false, recheckInMs: null });
    expect(
      agentBrowserWatchLease({
        panelVisible: true,
        appVisible: true,
        now,
        lastActiveAt: now - AGENT_BROWSER_IDLE_AFTER_MS,
      }),
    ).toEqual({ watching: false, recheckInMs: null });
  });
});

describe("createAgentBrowserLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const start = () => {
    const changes: boolean[] = [];
    const lease = createAgentBrowserLease({ onChange: (watching) => changes.push(watching) });
    return { lease, changes, last: () => changes.at(-1) };
  };

  it("watches as soon as the panel shows, and lets go when it hides or the app goes away", () => {
    const { lease, last } = start();
    lease.update(true, true);
    expect(last()).toBe(true);
    lease.update(true, false);
    expect(last()).toBe(false);
    lease.update(true, true);
    expect(last()).toBe(true);
    lease.update(false, true);
    expect(last()).toBe(false);
  });

  it("goes idle five minutes after the last activity, and comes back on the next", () => {
    const { lease, last } = start();
    lease.update(true, true);
    vi.advanceTimersByTime(AGENT_BROWSER_IDLE_AFTER_MS - 60_000);
    lease.noteActivity();
    // Activity moved the mark, so the first idle check finds the person still around.
    vi.advanceTimersByTime(60_000);
    expect(last()).toBe(true);
    vi.advanceTimersByTime(AGENT_BROWSER_IDLE_AFTER_MS - 60_000);
    expect(last()).toBe(false);
    lease.noteActivity();
    expect(last()).toBe(true);
  });

  it("counts showing the panel as activity, but not the app coming back", () => {
    const { lease, last } = start();
    lease.update(true, true);
    lease.update(true, false);
    vi.advanceTimersByTime(AGENT_BROWSER_IDLE_AFTER_MS);
    lease.update(true, true);
    expect(last()).toBe(false);
    lease.update(false, true);
    lease.update(true, true);
    expect(last()).toBe(true);
  });

  it("stops its idle timer when disposed, and starts it again on the next update", () => {
    const { lease, changes } = start();
    lease.update(true, true);
    lease.dispose();
    vi.advanceTimersByTime(AGENT_BROWSER_IDLE_AFTER_MS * 2);
    expect(changes).toEqual([true]);
    lease.update(true, true);
    expect(changes.at(-1)).toBe(false);
  });
});
