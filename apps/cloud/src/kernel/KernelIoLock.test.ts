import { describe, expect, it, vi } from "vite-plus/test";
import { KernelIoLock } from "./KernelIoLock.ts";
import { runKernelSuspensionObserver } from "./KernelSuspension.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";

describe("kernel I/O lock suspension", () => {
  it("keeps an immediately acquired lock ready", async () => {
    const lock = new KernelIoLock();
    const suspended = vi.fn();
    const release = await runKernelSuspensionObserver(suspended, () => runAsync(lock.acquire({})));
    try {
      expect(suspended).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("reports an actual queued acquisition before the current owner releases", async () => {
    const lock = new KernelIoLock();
    const releaseOwner = lock.tryAcquire({});
    if (releaseOwner === undefined) throw new Error("First lock owner was not admitted");
    const suspended = vi.fn();
    let acquired = false;
    const waiting = runKernelSuspensionObserver(suspended, () => runAsync(lock.acquire({}))).then(
      (release) => {
        acquired = true;
        return release;
      },
    );
    try {
      expect(suspended).toHaveBeenCalledOnce();
      expect(acquired).toBe(false);
    } finally {
      releaseOwner();
      const releaseWaiter = await waiting;
      releaseWaiter();
    }
    expect(acquired).toBe(true);
    expect(suspended).toHaveBeenCalledOnce();
  });
});
