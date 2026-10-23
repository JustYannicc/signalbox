import { describe, expect, it, vi } from "vite-plus/test";
import { fill, fixture, stopped } from "./fixture.ts";
import { createProcessSlots } from "../../ProcessSlots.ts";
import { InMemoryProcessSlotStore } from "./InMemoryProcessSlotStore.ts";

describe("process-slot pressure episodes", () => {
  it("re-arms capacity pressure behind a parked holder that has outgrown its isolate", async () => {
    const { slots, acquire, scheduled, quantum } = await fixture();
    const first = await acquire();
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const parked = slots.park(
      first.lease,
      first.permit,
      () => {
        entered.resolve();
        return ready.promise;
      },
      abort.signal,
    );
    const rejectedPark = expect(parked).rejects.toThrow();
    await entered.promise;
    slots.observe(first.lease, 150);
    ready.resolve();
    await scheduled;
    const held = await fill(acquire);
    const waiting = acquire("bash", 40, abort.signal);
    const rejected = expect(waiting).rejects.toThrow();
    await expect(slots.release({ ...first.lease, loaderId: "stale" }, stopped)).rejects.toThrow();
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    quantum();
    quantum();
    const events = listener.mock.calls.map(([event]) => event);
    abort.abort();
    await Promise.all([rejectedPark, rejected]);
    await Promise.all([first, ...held].map(({ lease }) => slots.release(lease, stopped)));
    expect(events.filter(({ kind }) => kind === "capacity")).toHaveLength(2);
    expect(events.filter(({ kind }) => kind === "unplaceable")).toEqual([
      expect.objectContaining({ lease: { ...first.lease, residentBytes: 150 } }),
    ]);
  });

  it("re-arms capacity pressure behind a stuck oversized head", async () => {
    const { slots, acquire, scheduled, quantum } = await fixture();
    const held = await fill(acquire);
    const abort = new AbortController();
    const oversized = acquire("large", 101, abort.signal);
    const backlog = Array.from({ length: 4 }, () => acquire("bash", 40, abort.signal));
    const rejected = [oversized, ...backlog].map((promise) => expect(promise).rejects.toThrow());
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    await scheduled;
    quantum();
    quantum();
    quantum();
    const events = listener.mock.calls.map(([event]) => event);
    abort.abort();
    await Promise.all(rejected);
    await Promise.all(held.map(({ lease }) => slots.release(lease, stopped)));
    expect(events.filter(({ kind }) => kind === "capacity")).toHaveLength(3);
    expect(events.filter(({ kind }) => kind === "unplaceable")).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ codeId: "large", residentBytes: 101 }),
      }),
    ]);
  });

  it("reports an oversized request once without driving capacity pressure", async () => {
    const { slots, acquire, scheduled, quantum } = await fixture();
    const abort = new AbortController();
    const request = acquire("large", 101, abort.signal);
    const rejected = expect(request).rejects.toThrow();
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    await scheduled;
    quantum();
    quantum();
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      kind: "unplaceable",
      inFlight: 0,
      resident: 0,
      waiting: 1,
      request: {
        owner: "supervisor/shard-a",
        codeId: "large",
        residentBytes: 101,
        signal: abort.signal,
      },
    });
    abort.abort();
    await rejected;
  });

  it("starts a new capacity episode after unplaceable pressure already fired", async () => {
    const { slots, acquire, scheduled, quantum } = await fixture();
    const abort = new AbortController();
    const oversized = acquire("large", 101, abort.signal);
    const rejected = expect(oversized).rejects.toThrow();
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    await scheduled;
    quantum();
    const held = await fill(acquire);
    const waiting = acquire();
    await slots.release(held[0]!.lease, stopped);
    const replacement = await waiting;
    const backlog = acquire("bash", 40, abort.signal);
    const rejectedBacklog = expect(backlog).rejects.toThrow();
    // A state-changing operation fences the admission scan without consuming capacity.
    await expect(slots.release(held[0]!.lease, stopped)).rejects.toThrow(/stale/i);
    quantum();
    quantum();
    const capacity = listener.mock.calls
      .map(([event]) => event)
      .filter(({ kind }) => kind === "capacity");
    abort.abort();
    await Promise.all([rejected, rejectedBacklog]);
    await slots.release(replacement.lease, stopped);
    expect(capacity).toHaveLength(2);
  });

  it("exposes the measured parked lease that cannot fit", async () => {
    const { slots, acquire, scheduled, quantum } = await fixture();
    const first = await acquire();
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<string>();
    const abort = new AbortController();
    const parked = slots.park(
      first.lease,
      first.permit,
      () => {
        entered.resolve();
        return ready.promise;
      },
      abort.signal,
    );
    const rejected = expect(parked).rejects.toThrow();
    await entered.promise;
    slots.observe(first.lease, 150);
    ready.resolve("resume");
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    await scheduled;
    quantum();
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      kind: "unplaceable",
      inFlight: 0,
      resident: 1,
      waiting: 1,
      lease: { ...first.lease, residentBytes: 150 },
    });
    abort.abort();
    await rejected;
    await slots.release(first.lease, stopped);
  });

  it("continues admission after scheduleQuantum throws", async () => {
    let fail = true;
    const attempted = Promise.withResolvers<void>();
    const { slots, acquire } = await fixture({
      scheduleQuantum() {
        attempted.resolve();
        if (fail) throw new Error("scheduler failed");
        return () => {};
      },
    });
    const held = await fill(acquire);
    const waiting = acquire();
    await attempted.promise;
    fail = false;
    await slots.release(held[0]!.lease, stopped);
    await waiting;
    expect(slots.signals.inFlight).toBe(4);
  });

  it("isolates a throwing pressure listener and keeps scheduling", async () => {
    const { slots, acquire, scheduled, quantum } = await fixture();
    const held = await fill(acquire);
    const abort = new AbortController();
    const waiting = acquire("bash", 40, abort.signal);
    const rejected = expect(waiting).rejects.toThrow();
    slots.signals.onPressure(() => {
      throw new Error("listener failed");
    });
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    await scheduled;
    expect(() => quantum()).not.toThrow();
    expect(() => quantum()).not.toThrow();
    abort.abort();
    await rejected;
    await Promise.all(held.map(({ lease }) => slots.release(lease, stopped)));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps pressure armable when a scheduler runs its callback before returning", async () => {
    let calls = 0;
    let synchronous = true;
    const later = new Set<() => void>();
    const slots = await createProcessSlots({
      owner: "supervisor/shard-a",
      inFlightLimit: 1,
      residentByteLimit: 100,
      store: new InMemoryProcessSlotStore(),
      invalidate() {},
      scheduleQuantum(callback) {
        calls++;
        if (synchronous) callback();
        else later.add(callback);
        return () => later.delete(callback);
      },
      async reconcile() {
        return stopped;
      },
    });
    const listener = vi.fn();
    slots.signals.onPressure(listener);
    const abort = new AbortController();
    const request = (codeId: string, signal: AbortSignal) => ({
      owner: "supervisor/shard-a",
      codeId,
      residentBytes: 1,
      signal,
    });
    const held = await slots.acquire(request("bash", new AbortController().signal));
    const second = slots.acquire(request("bash", abort.signal));
    const secondRejected = expect(second).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    synchronous = false;
    const third = slots.acquire(request("js", abort.signal));
    const thirdRejected = expect(third).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(later.size).toBe(1);
    // Snapshot: a firing callback re-arms into the same set.
    for (const callback of Array.from(later)) callback();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "capacity", waiting: 2 }),
    );

    abort.abort();
    await Promise.all([secondRejected, thirdRejected]);
    await slots.release(held.lease, stopped);
  });
});
