import { describe, expect, it, vi } from "vite-plus/test";
import { fixture, stopped } from "./fixture.ts";

describe("process-slot failure races", () => {
  it("validates permits by token after transport copies the handle", async () => {
    const { slots, acquire } = await fixture();
    const { lease, permit } = await acquire();
    const resumed = await slots.park(
      lease,
      { ...permit },
      async () => "ready",
      new AbortController().signal,
    );
    expect(resumed.value).toBe("ready");
    expect(resumed.permit.token).toBe(lease.token);
    await slots.release(lease, stopped);
  });

  it("requires recovery after a failed loss save, preserving the retired generation", async () => {
    const first = await fixture();
    const { lease } = await first.acquire();
    first.store.failure = new Error("loss save failed");
    await expect(first.slots.lose(lease, "memory")).rejects.toMatchObject({
      name: "ProcessSlotStorageError",
    });
    first.store.failure = undefined;
    await expect(first.slots.release(lease, stopped)).rejects.toMatchObject({
      name: "ProcessSlotStorageError",
    });
    await expect(first.acquire()).rejects.toMatchObject({ name: "ProcessSlotStorageError" });
    const recovered = await fixture({
      store: first.store,
      reconcile: async () => ({ lost: "memory" }),
    });
    expect((await recovered.acquire()).lease.loaderId).toBe("supervisor/shard-a/bash/0.1");
  });

  it("does not start the parked wait if its permit release cannot commit", async () => {
    const { slots, acquire, store } = await fixture();
    const { lease, permit } = await acquire();
    const waitFor = vi.fn(async () => "ready");
    store.failure = new Error("park save failed");
    await expect(
      slots.park(lease, permit, waitFor, new AbortController().signal),
    ).rejects.toMatchObject({ name: "ProcessSlotStorageError" });
    expect(waitFor).not.toHaveBeenCalled();
    expect(slots.signals.inFlight).toBe(1);
    store.failure = undefined;
    expect((await slots.park(lease, permit, waitFor, new AbortController().signal)).value).toBe(
      "ready",
    );
    await slots.release(lease, stopped);
  });

  it("keeps a parked lease when its wait is aborted, until stop is acknowledged", async () => {
    const { slots, acquire, store } = await fixture();
    const first = await acquire();
    const entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    const pending = slots.park(
      first.lease,
      first.permit,
      () => {
        entered.resolve();
        return new Promise<void>(() => {});
      },
      abort.signal,
    );
    await entered.promise;
    abort.abort();
    await expect(pending).rejects.toBe(abort.signal.reason);
    expect(slots.signals.inFlight).toBe(0);
    expect(slots.signals.resident).toBe(1);
    expect((await store.load())?.slots[0]?.holder?.permitted).toBe(false);
    const next = await acquire();
    expect(next.lease.loaderId).not.toBe(first.lease.loaderId);
    await slots.release(first.lease, stopped);
    expect((await acquire()).lease.loaderId).toBe(first.lease.loaderId);
  });

  it("rejects waitFor immediately even if the parked lease can no longer fit", async () => {
    const { slots, acquire, scheduled } = await fixture();
    const first = await acquire();
    const failure = new Error("pipe closed");
    const entered = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const abort = new AbortController();
    const parked = slots.park(
      first.lease,
      first.permit,
      () => {
        entered.resolve();
        return waiting.promise;
      },
      abort.signal,
    );
    const settled = parked.then(
      () => "resolved",
      () => "rejected",
    );
    await entered.promise;
    slots.observe(first.lease, 150);
    waiting.reject(failure);
    const outcome = await Promise.race([settled, scheduled.then(() => "queued")]);
    try {
      expect(outcome).toBe("rejected");
      await expect(parked).rejects.toBe(failure);
      expect(slots.signals.inFlight).toBe(0);
      expect(slots.signals.resident).toBe(1);
    } finally {
      abort.abort();
      await settled;
      await slots.release(first.lease, stopped);
    }
  });

  it.each(["release", "lose"] as const)(
    "rejects a parked operation when its holder is retired by %s",
    async (operation) => {
      const { slots, acquire } = await fixture();
      const first = await acquire();
      const entered = Promise.withResolvers<void>();
      const pending = slots.park(
        first.lease,
        first.permit,
        () => {
          entered.resolve();
          return new Promise<void>(() => {});
        },
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toThrow(/stale/i);
      await entered.promise;
      if (operation === "lose") await slots.lose(first.lease, "isolate");
      else await slots.release(first.lease, stopped);
      await rejected;
      expect(slots.signals.inFlight).toBe(0);
      expect(slots.signals.resident).toBe(0);
    },
  );

  it("retains a retirement record when stub invalidation fails, then retries it on recovery", async () => {
    const failure = new Error("stub eviction failed");
    const first = await fixture({
      invalidate: () => {
        throw failure;
      },
    });
    const { lease } = await first.acquire();
    await expect(first.slots.lose(lease, "memory")).rejects.toBe(failure);
    expect((await first.store.load())?.slots[0]).toMatchObject({ generation: 1, invalidating: 0 });
    await expect(first.acquire()).rejects.toBe(failure);
    const invalidate = vi.fn();
    const recovered = await fixture({ store: first.store, invalidate });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(lease.loaderId);
    expect((await recovered.acquire()).lease.loaderId).toBe("supervisor/shard-a/bash/0.1");
  });

  it("keeps measurements in memory when storage is unavailable", async () => {
    const { slots, acquire, store } = await fixture();
    const { lease } = await acquire();
    const failure = new Error("measurement save failed");
    store.failure = failure;
    slots.observe(lease, 120);
    await expect(acquire()).rejects.toMatchObject({
      name: "ProcessSlotStorageError",
      cause: failure,
    });
    expect(slots.signals.resident).toBe(1);
    store.failure = undefined;
    await acquire();
    expect((await store.load())?.slots[0]?.holder?.residentBytes).toBe(120);
  });

  it("preserves safe-point measurements ahead of admission while another save is in progress", async () => {
    const { slots, acquire, store, scheduled } = await fixture();
    const first = await acquire();
    const unblock = Promise.withResolvers<void>();
    const parked = Promise.withResolvers<void>();
    const resume = slots.park(
      first.lease,
      first.permit,
      () => {
        parked.resolve();
        return unblock.promise;
      },
      new AbortController().signal,
    );
    await parked.promise;
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    store.beforeSave = async () => {
      entered.resolve();
      await commit.promise;
    };
    const other = acquire();
    await entered.promise;
    slots.observe(first.lease, 120);
    unblock.resolve();
    commit.resolve();
    await other;
    await scheduled;
    expect(slots.signals.inFlight).toBe(1);
    expect((await store.load())?.slots[0]?.holder?.permitted).toBe(false);
    slots.observe(first.lease, 80);
    await resume;
  });
});
