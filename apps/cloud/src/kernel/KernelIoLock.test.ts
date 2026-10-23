import { describe, expect, it, vi } from "vite-plus/test";
import { KernelIoLock } from "./KernelIoLock.ts";
import { runKernelSuspensionObserver } from "./KernelSuspension.ts";

describe("kernel I/O lock suspension", () => {
  it("keeps an immediately acquired lock ready", () => {
    const lock = new KernelIoLock();
    const suspended = vi.fn();
    const acquisition = lock.acquire({});
    const result = runKernelSuspensionObserver(suspended, () => acquisition.next());
    expect(result.done).toBe(true);
    if (!result.done) throw new Error("Immediate acquisition suspended");
    try {
      expect(suspended).not.toHaveBeenCalled();
    } finally {
      result.value();
    }
  });

  it("reports an actual queued acquisition before the current owner releases", async () => {
    const lock = new KernelIoLock();
    const releaseOwner = lock.tryAcquire({});
    if (releaseOwner === undefined) throw new Error("First lock owner was not admitted");
    const suspended = vi.fn();
    const acquisition = lock.acquire({});
    const queued = runKernelSuspensionObserver(suspended, () => acquisition.next());
    try {
      expect(queued.done).toBe(false);
      expect(suspended).toHaveBeenCalledOnce();
    } finally {
      releaseOwner();
      if (!queued.done) await queued.value;
      const acquired = acquisition.next();
      expect(acquired.done).toBe(true);
      if (!acquired.done) throw new Error("Released waiter did not acquire the lock");
      acquired.value();
    }
    expect(suspended).toHaveBeenCalledOnce();
  });
});
