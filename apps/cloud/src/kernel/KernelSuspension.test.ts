import { describe, expect, it, vi } from "@effect/vitest";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { notifyKernelSuspension, runKernelSuspensionObserver } from "./KernelSuspension.ts";
import { WasiClock } from "./wasi/internal_wasi_clock.ts";
import { runAsync } from "./wasi/internal_wasi_calls.ts";
import { WasiMemory } from "./wasi/internal_wasi_memory.ts";
import { WasiPoller } from "./wasi/internal_wasi_poll.ts";

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
    const memory = new WebAssembly.Memory({ initial: 1 });
    const wasiMemory = new WasiMemory();
    wasiMemory.set(memory);
    const clock = new WasiClock();
    vi.spyOn(clock, "now").mockReturnValue(200n);
    const wait = vi.spyOn(clock, "wait");
    const poller = new WasiPoller(wasiMemory, true, undefined, clock);
    writeClockSubscription(memory, 100n);
    const observed = vi.fn();

    await expect(
      runKernelSuspensionObserver(observed, () => runAsync(poller.pollOneoff(0, 64, 1, 96))),
    ).resolves.toBe(0);
    expect(observed).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(new DataView(memory.buffer).getUint32(96, true)).toBe(1);
  });

  it("marks a clock poll at its actual wait and resumes on the clock milestone", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const wasiMemory = new WasiMemory();
    wasiMemory.set(memory);
    const clock = new WasiClock();
    let now = 100n;
    vi.spyOn(clock, "now").mockImplementation(() => now);
    const milestone = deferred<void>();
    const wait = vi.spyOn(clock, "wait").mockReturnValue(milestone.promise);
    const poller = new WasiPoller(wasiMemory, true, undefined, clock);
    writeClockSubscription(memory, 200n);
    const observed = vi.fn();

    const pending = runKernelSuspensionObserver(observed, () =>
      runAsync(poller.pollOneoff(0, 64, 1, 96)),
    );
    expect(observed).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);

    now = 200n;
    milestone.resolve();
    await expect(pending).resolves.toBe(0);
    expect(new DataView(memory.buffer).getUint32(96, true)).toBe(1);
  });
});

function writeClockSubscription(memory: WebAssembly.Memory, deadline: bigint) {
  const subscription = new DataView(memory.buffer, 0, 48);
  subscription.setBigUint64(0, 1n, true);
  subscription.setUint8(8, 0);
  subscription.setUint32(16, 1, true);
  subscription.setBigUint64(24, deadline, true);
  subscription.setUint16(40, 1, true);
  new DataView(memory.buffer).setUint32(96, 0, true);
}
