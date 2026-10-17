import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  adoptNeedsYouDefaults,
  completionEarnsSignal,
  createNeedsYouToasts,
  markNeedsYouDefaultsAdopted,
  needsYouToastTimeout,
} from "./needsYouSignals";

const finished = (
  creationSource: "web" | "mobile" | "server" | "mcp" | "provider",
  seconds: number,
) => ({
  latestRun: {
    runId: "run-1" as never,
    status: "completed" as const,
    requestedAt: "2026-10-17T10:00:00.000Z",
    startedAt: "2026-10-17T10:00:00.000Z",
    completedAt: new Date(Date.parse("2026-10-17T10:00:00.000Z") + seconds * 1000).toISOString(),
    assistantMessageId: null,
  },
  source: { creationSource },
});

describe("completionEarnsSignal", () => {
  it("signals a long turn in a thread a person started", () => {
    expect(completionEarnsSignal(finished("web", 60))).toBe(true);
    expect(completionEarnsSignal(finished("mobile", 300))).toBe(true);
  });

  it("stays quiet for short turns, which the person was still watching", () => {
    expect(completionEarnsSignal(finished("web", 20))).toBe(false);
    expect(completionEarnsSignal(finished("web", 59.9))).toBe(false);
  });

  it("stays quiet for threads automations and agents started", () => {
    expect(completionEarnsSignal(finished("server", 600))).toBe(false);
    expect(completionEarnsSignal(finished("mcp", 600))).toBe(false);
    expect(completionEarnsSignal(finished("provider", 600))).toBe(false);
  });

  it("stays quiet without a run that started and finished", () => {
    expect(completionEarnsSignal({ latestRun: null, source: { creationSource: "web" } })).toBe(
      false,
    );
  });
});

describe("needsYouToastTimeout", () => {
  it("keeps questions, approvals and failures until handled, lets completions go", () => {
    expect(needsYouToastTimeout("input")).toBe(0);
    expect(needsYouToastTimeout("completion")).toBeUndefined();
  });
});

describe("createNeedsYouToasts", () => {
  it("keeps the toast while the thread waits on the same thing", () => {
    const close = vi.fn();
    const toasts = createNeedsYouToasts(close);
    toasts.add("thread-1", "run-1:input", "toast-1");
    toasts.sync("thread-1", "run-1:input", false);
    expect(close).not.toHaveBeenCalled();
  });

  it("closes it once the thread stops waiting, or waits on something else", () => {
    const close = vi.fn();
    const toasts = createNeedsYouToasts(close);
    toasts.add("thread-1", "run-1:input", "toast-1");
    toasts.add("thread-2", "run-2:failed", "toast-2");
    toasts.sync("thread-1", null, false);
    toasts.sync("thread-2", "run-3:failed", false);
    expect(close.mock.calls).toEqual([["toast-1"], ["toast-2"]]);
    // Already closed: later updates don't close it again.
    toasts.sync("thread-1", null, false);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("closes it when the person opens the thread", () => {
    const close = vi.fn();
    const toasts = createNeedsYouToasts(close);
    toasts.add("thread-1", "run-1:approval", "toast-1");
    toasts.sync("thread-1", "run-1:approval", true);
    expect(close).toHaveBeenCalledWith("toast-1");
  });

  it("closes toasts of threads that left the snapshot, and all of them on teardown", () => {
    const close = vi.fn();
    const toasts = createNeedsYouToasts(close);
    toasts.add("thread-1", "run-1:input", "toast-1");
    toasts.add("thread-2", "run-2:failed", "toast-2");
    toasts.add("thread-3", "run-3:approval", "toast-3");
    toasts.retain(new Set(["thread-1", "thread-3"]));
    expect(close.mock.calls).toEqual([["toast-2"]]);
    toasts.closeAll();
    expect(close.mock.calls).toEqual([["toast-2"], ["toast-1"], ["toast-3"]]);
  });

  it("replaces a thread's earlier toast with its newer one", () => {
    const close = vi.fn();
    const toasts = createNeedsYouToasts(close);
    toasts.add("thread-1", "run-1:input", "toast-1");
    toasts.add("thread-1", "run-1:failed", "toast-2");
    expect(close).toHaveBeenCalledWith("toast-1");
  });
});

describe("adoptNeedsYouDefaults", () => {
  const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  };

  const off = { ...DEFAULT_CLIENT_SETTINGS, inAppNotificationsEnabled: false };

  it("turns in-app notifications on once for settings saved under the old default", async () => {
    const storage = memoryStorage();
    const persist = vi.fn();
    expect((await adoptNeedsYouDefaults(off, persist, storage))?.inAppNotificationsEnabled).toBe(
      true,
    );
    expect(persist).toHaveBeenCalledWith({ ...off, inAppNotificationsEnabled: true });
  });

  it("keeps them off when the person turns them off afterwards", async () => {
    const storage = memoryStorage();
    await adoptNeedsYouDefaults(off, vi.fn(), storage);
    const persist = vi.fn();
    expect(await adoptNeedsYouDefaults(off, persist, storage)).toBe(off);
    expect(persist).not.toHaveBeenCalled();
  });

  it("records the adoption on a fresh device, so a later opt-out sticks", async () => {
    const storage = memoryStorage();
    expect(await adoptNeedsYouDefaults(null, vi.fn(), storage)).toBeNull();
    expect(DEFAULT_CLIENT_SETTINGS.inAppNotificationsEnabled).toBe(true);
    // The person turns them off; the next load keeps that choice.
    const persist = vi.fn();
    expect(await adoptNeedsYouDefaults(off, persist, storage)).toBe(off);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps an opt-out saved after a failed migration write", async () => {
    const storage = memoryStorage();
    await adoptNeedsYouDefaults(
      off,
      () => Promise.reject(new Error("bridge unavailable")),
      storage,
    );
    // The person then turns them off and that write succeeds.
    markNeedsYouDefaultsAdopted(storage);
    const persist = vi.fn();
    expect(await adoptNeedsYouDefaults(off, persist, storage)).toBe(off);
    expect(persist).not.toHaveBeenCalled();
  });

  it("retries on the next load when writing the adopted settings fails", async () => {
    const storage = memoryStorage();
    const failing = vi.fn(() => Promise.reject(new Error("bridge unavailable")));
    expect((await adoptNeedsYouDefaults(off, failing, storage))?.inAppNotificationsEnabled).toBe(
      true,
    );
    expect(storage.getItem("signalbox:needs-you-defaults:v1")).toBeNull();
    const persist = vi.fn(() => Promise.resolve());
    await adoptNeedsYouDefaults(off, persist, storage);
    expect(persist).toHaveBeenCalledWith({ ...off, inAppNotificationsEnabled: true });
    expect(storage.getItem("signalbox:needs-you-defaults:v1")).toBe("1");
  });
});
