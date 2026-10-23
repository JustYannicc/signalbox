import { describe, expect, it, vi } from "vite-plus/test";
import { fill, fixture, stopped } from "./fixture.ts";

describe("process-slot admission", () => {
  it("lets requests that fit proceed past an oversized resident-byte waiter", async () => {
    const { slots, acquire, scheduled } = await fixture();
    const abort = new AbortController();
    const oversized = acquire("js", 101, abort.signal);
    const fitting = acquire();
    await scheduled;
    try {
      expect(slots.signals.inFlight).toBe(1);
    } finally {
      abort.abort();
      await expect(oversized).rejects.toBe(abort.signal.reason);
      await fitting;
    }
  });

  it("keeps more than 64 resident leases when blocked processes release their permits", async () => {
    const { slots, acquire } = await fixture();
    const held = [];
    const parked = [];
    for (let index = 0; index < 70; index++) {
      const { lease, permit } = await acquire();
      held.push(lease);
      const entered = Promise.withResolvers<void>();
      const result = slots.park(
        lease,
        permit,
        () => {
          entered.resolve();
          return new Promise<void>(() => {});
        },
        new AbortController().signal,
      );
      parked.push(expect(result).rejects.toThrow(/stale/i));
      await entered.promise;
    }
    expect(slots.signals.resident).toBe(70);
    expect(slots.signals.inFlight).toBe(0);
    expect(new Set(held.map((lease) => lease.loaderId)).size).toBe(70);
    await Promise.all(held.map((lease) => slots.release(lease, stopped)));
    await Promise.all(parked);
  });

  it.each([4, 10])(
    "enforces the supplied in-flight limit %i independently of resident count",
    async (cap) => {
      const { slots, acquire } = await fixture({ inFlightLimit: cap });
      const held = await fill(acquire, cap);
      const waiting = acquire();
      expect(slots.signals.inFlight).toBe(cap);
      expect(slots.signals.waiting).toBe(1);
      await slots.release(held[0]!.lease, stopped);
      await waiting;
      expect(slots.signals.inFlight).toBe(cap);
    },
  );

  it("waits FIFO and removes an aborted capacity waiter", async () => {
    const { slots, acquire } = await fixture();
    const held = await fill(acquire);
    const order: number[] = [];
    const first = acquire().then((value) => {
      order.push(1);
      return value;
    });
    const abort = new AbortController();
    const cancelled = acquire("bash", 40, abort.signal);
    const last = acquire().then((value) => {
      order.push(3);
      return value;
    });
    abort.abort();
    await expect(cancelled).rejects.toBe(abort.signal.reason);
    expect(slots.signals.waiting).toBe(2);
    await slots.release(held[0]!.lease, stopped);
    const next = await first;
    expect(order).toEqual([1]);
    await slots.release(next.lease, stopped);
    await last;
    expect(order).toEqual([1, 3]);
  });

  it("emits pressure only after a blocked scheduling quantum, with unsubscribe", async () => {
    const { slots, acquire, quantum, scheduled } = await fixture();
    const held = await fill(acquire);
    const listener = vi.fn();
    const unsubscribe = slots.signals.onPressure(listener);
    const waiting = acquire();
    await scheduled;
    expect(listener).not.toHaveBeenCalled();
    quantum();
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      kind: "capacity",
      inFlight: 4,
      resident: 4,
      waiting: 1,
    });
    unsubscribe();
    quantum();
    expect(listener).toHaveBeenCalledTimes(1);
    await slots.release(held[0]!.lease, stopped);
    await waiting;
  });

  it("admits bytes per isolate rather than summing residency across the shard", async () => {
    const { slots, acquire } = await fixture();
    await fill(() => acquire("js", 90));
    expect(slots.signals.resident).toBe(4);
    const abort = new AbortController();
    const tooLarge = acquire("js", 101, abort.signal);
    abort.abort();
    await expect(tooLarge).rejects.toBe(abort.signal.reason);
  });

  it("uses safe-point byte measurements when re-admitting a parked holder", async () => {
    const { slots, acquire } = await fixture();
    const first = await acquire();
    const wait = Promise.withResolvers<string>();
    const parked = Promise.withResolvers<void>();
    const resumed = slots.park(
      first.lease,
      first.permit,
      () => {
        parked.resolve();
        return wait.promise;
      },
      new AbortController().signal,
    );
    await parked.promise;
    slots.observe(first.lease, 120);
    wait.resolve("continue");
    const other = await acquire();
    expect(slots.signals.inFlight).toBe(1);
    expect(slots.signals.resident).toBe(2);
    slots.observe(first.lease, 80);
    expect((await resumed).value).toBe("continue");
    expect(slots.signals.inFlight).toBe(2);
    await slots.release(other.lease, stopped);
  });
});
