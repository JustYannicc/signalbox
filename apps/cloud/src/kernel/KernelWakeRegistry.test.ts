import { describe, expect, it } from "@effect/vitest";

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
