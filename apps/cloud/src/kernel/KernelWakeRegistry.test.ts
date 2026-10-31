import { describe, expect, it } from "@effect/vitest";

import { vi } from "vite-plus/test";

import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import { KernelCpuExecution } from "./KernelCpuExecution.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

describe("KernelWakeRegistry CPU delivery", () => {
  it("rejects a failed resume exactly once and releases its subscription and token", async () => {
    let failed = false;
    const failure = new Error("resume clock failed");
    const execution = new KernelCpuExecution(
      new KernelCpuAccounting(() => {
        if (failed) throw failure;
        return 0n;
      }),
    );
    const wakes = new KernelWakeRegistry();
    const signal = new AbortController();
    let unsubscribed = 0;
    const registered = wakes.register(() => () => {
      unsubscribed++;
    });
    if (registered.status !== "ok") throw new Error("Wake registration failed");
    let rejected = 0;
    const waiting = execution.root.run(() => {
      const leave = execution.root.enterUser();
      return wakes.wait(registered.value, signal.signal).catch((error: unknown) => {
        rejected++;
        failed = false;
        expect(error).toBe(failure);
        execution.root.runUser(() => {});
        leave();
      });
    });
    failed = true;
    expect(wakes.signal(registered.value)).toBe(true);
    expect(wakes.signal(registered.value)).toBe(false);
    await waiting;
    signal.abort();
    expect(rejected).toBe(1);
    expect(unsubscribed).toBe(1);
    expect(wakes.size).toBe(0);
    expect(wakes.release(registered.value)).toBe(false);
    expect(execution.root.stop()).toEqual({ userNs: 0n, systemNs: 0n });
    wakes.dispose();
  });
});

describe("KernelWakeRegistry ownership", () => {
  it("reclaims unclaimed pending and completed registrations", async () => {
    vi.useFakeTimers();
    const wakes = new KernelWakeRegistry();
    const unsubscribe = vi.fn();
    try {
      wakes.register(() => unsubscribe);
      wakes.register((notify) => {
        notify();
        return unsubscribe;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wakes.size).toBe(0);
      expect(unsubscribe).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      wakes.dispose();
      vi.useRealTimers();
    }
  });

  it.each([90_000, 120_000, 180_000])("retains an active wait for %i ms", async (duration) => {
    vi.useFakeTimers();
    const wakes = new KernelWakeRegistry();
    const unsubscribe = vi.fn();
    let notify = () => {};
    try {
      const registered = wakes.register((wake) => {
        notify = wake;
        return unsubscribe;
      });
      if (registered.status !== "ok") throw new Error("Wake registration failed");
      const waiting = wakes.wait(registered.value);
      await vi.advanceTimersByTimeAsync(duration);
      expect(wakes.has(registered.value)).toBe(true);
      expect(unsubscribe).not.toHaveBeenCalled();
      notify();
      await expect(waiting).resolves.toEqual({ status: "ok", value: undefined });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(wakes.size).toBe(0);
    } finally {
      wakes.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["abort", "release", "dispose"] as const)(
    "cleans up a long wait on %s",
    async (action) => {
      vi.useFakeTimers();
      const wakes = new KernelWakeRegistry();
      const unsubscribe = vi.fn();
      const controller = new AbortController();
      try {
        const registered = wakes.register(() => unsubscribe);
        if (registered.status !== "ok") throw new Error("Wake registration failed");
        const waiting = wakes.wait(registered.value, controller.signal);
        await vi.advanceTimersByTimeAsync(180_000);
        if (action === "abort") controller.abort();
        else if (action === "release") wakes.release(registered.value);
        else wakes.dispose();
        await expect(waiting).resolves.toMatchObject({
          status: "error",
          error: { code: "CANCELLED" },
        });
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(wakes.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        wakes.dispose();
        vi.useRealTimers();
      }
    },
  );
});
