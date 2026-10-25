import { describe, expect, it } from "vite-plus/test";
import { fill, fixture, stopped } from "./fixture.ts";

describe("resident process-slot identities", () => {
  it("reuses an index warm only after the previous stop is acknowledged", async () => {
    const { slots, acquire } = await fixture();
    const first = await acquire();
    const second = await acquire();
    expect(second.lease.loaderId).not.toBe(first.lease.loaderId);
    await slots.release(first.lease, stopped);
    const warm = await acquire();
    expect(warm.lease.loaderId).toBe(first.lease.loaderId);
    expect(warm.lease.token).not.toBe(first.lease.token);
    expect(slots.signals.resident).toBe(2);
  });

  it("ignores stale observations and rejects stale callbacks on same-generation reuse", async () => {
    const { slots, acquire, invalidate } = await fixture();
    const old = await acquire();
    await slots.release(old.lease, stopped);
    const current = await acquire();
    slots.observe(old.lease, 900);
    await expect(slots.release(old.lease, stopped)).rejects.toThrow(/stale/i);
    await expect(slots.handoff(old.lease, stopped)).rejects.toThrow(/stale/i);
    await expect(slots.lose(old.lease, "memory")).rejects.toThrow(/stale/i);
    await expect(
      slots.park(current.lease, old.permit, async () => 1, new AbortController().signal),
    ).rejects.toThrow(/permit/i);
    expect(invalidate).not.toHaveBeenCalled();
    expect(current.lease.loaderId).toBe(old.lease.loaderId);
    expect(slots.signals.inFlight).toBe(1);
    await slots.release(current.lease, stopped);
  });

  it.each(["memory", "isolate"] as const)(
    "retires the generation and invalidates the lost %s stub",
    async (reason) => {
      const { slots, acquire, store, invalidate } = await fixture();
      const first = await acquire();
      await slots.lose(first.lease, reason);
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(first.lease.loaderId);
      expect((await store.load())?.slots[0]?.generation).toBe(1);
      const next = await acquire();
      expect(next.lease.loaderId).toBe("supervisor/shard-a/bash/0.1");
      expect(slots.signals.lost).toBe(1);
    },
  );

  it("does not release a handoff until its stop acknowledgement commits", async () => {
    const { slots, acquire, store } = await fixture();
    const current = await acquire();
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    store.beforeSave = async () => {
      entered.resolve();
      await commit.promise;
    };
    const handoff = slots.handoff(current.lease, stopped);
    await entered.promise;
    expect(slots.signals.resident).toBe(1);
    commit.resolve();
    await handoff;
    expect(slots.signals.resident).toBe(0);
    const next = await acquire();
    expect(next.lease.loaderId).toBe(current.lease.loaderId);
  });

  it("parks only the permit, admits another process and queues resumption FIFO", async () => {
    const { slots, acquire } = await fixture();
    const [first, ...others] = await fill(acquire);
    const blocked = Promise.withResolvers<string>();
    const parked = Promise.withResolvers<void>();
    const running = slots.park(
      first!.lease,
      first!.permit,
      () => {
        parked.resolve();
        return blocked.promise;
      },
      new AbortController().signal,
    );
    await parked.promise;
    expect(slots.signals.inFlight).toBe(3);
    expect(slots.signals.resident).toBe(4);
    const other = await acquire();
    expect(other.lease.loaderId).not.toBe(first!.lease.loaderId);
    const waiting = acquire();
    blocked.resolve("ready");
    await slots.release(others[0]!.lease, stopped);
    const admitted = await waiting;
    expect(slots.signals.inFlight).toBe(4);
    await slots.release(admitted.lease, stopped);
    const resumed = await running;
    expect(resumed.value).toBe("ready");
    expect(resumed.permit.token).toBe(first!.lease.token);
    expect(slots.signals.resident).toBe(4);
    await slots.release(first!.lease, stopped);
  });

  it("keeps namespaces from distinct owners and code IDs separate", async () => {
    const a = await fixture();
    const b = await fixture({ owner: "supervisor/shard-b" });
    const c = await fixture({ owner: "other-supervisor/shard-a" });
    const leases = await Promise.all([a.acquire(), b.acquire(), c.acquire(), a.acquire("js")]);
    expect(new Set(leases.map(({ lease }) => lease.loaderId)).size).toBe(4);
  });
});
