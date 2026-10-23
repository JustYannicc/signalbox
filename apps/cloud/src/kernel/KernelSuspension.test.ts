import { describe, expect, it, vi } from "@effect/vitest";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { notifyKernelSuspension, runKernelSuspensionObserver } from "./KernelSuspension.ts";
import { createKernelPollFixture } from "./tests/kernelPollFixture.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("kernel suspension observation", () => {
  it("notifies only the active async operation observer", async () => {
    const observed = vi.fn();
    const milestone = deferred<void>();
    const work = runKernelSuspensionObserver(observed, async () => {
      await milestone.promise;
      notifyKernelSuspension();
    });
    expect(observed).not.toHaveBeenCalled();
    milestone.resolve();
    await work;

    notifyKernelSuspension();
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("marks a wake wait only when it remains unresolved after waiter installation", async () => {
    const wakes = new KernelWakeRegistry();
    const observed = vi.fn();
    let wake: (() => void) | undefined;
    const waiting = wakes.register((notify) => {
      wake = notify;
      return () => {};
    });
    if (waiting.status !== "ok") throw new Error("Wake registration failed");

    const suspended = runKernelSuspensionObserver(observed, () => wakes.wait(waiting.value));
    expect(observed).toHaveBeenCalledTimes(1);
    wake!();
    await expect(suspended).resolves.toEqual({ status: "ok", value: undefined });

    const alreadyReady = wakes.register(() => () => {});
    if (alreadyReady.status !== "ok") throw new Error("Wake registration failed");
    wakes.signal(alreadyReady.value);
    await expect(
      runKernelSuspensionObserver(observed, () => wakes.wait(alreadyReady.value)),
    ).resolves.toEqual({ status: "ok", value: undefined });
    expect(observed).toHaveBeenCalledTimes(1);
    wakes.dispose();
  });

  it("does not count immediately ready clock polls as suspension", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(200);
    const fixture = createKernelPollFixture(100);
    const observed = vi.fn();
    try {
      const response = await runKernelSuspensionObserver(observed, () =>
        fixture.call(fixture.request),
      );
      expect(observed).not.toHaveBeenCalled();
      expect(fixture.eventCount(response)).toBe(1);
    } finally {
      fixture.abort();
      fixture.close();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("marks a clock poll at its actual wait and resumes on the clock milestone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let nowMs = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const fixture = createKernelPollFixture(200);
    const observed = vi.fn();
    let settled = false;
    const pending = runKernelSuspensionObserver(observed, () => fixture.call(fixture.request));
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      expect(observed).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      nowMs = 200;
      await vi.advanceTimersByTimeAsync(100);
      const response = await pending;
      expect(fixture.eventCount(response)).toBe(1);
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      fixture.abort();
      await pending.catch(() => {});
      fixture.close();
      now.mockRestore();
      vi.useRealTimers();
    }
  });
});
