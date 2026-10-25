import { describe, expect, it, vi } from "vite-plus/test";
import { fixture, stopped } from "./fixture.ts";
import { InMemoryProcessSlotStore } from "./InMemoryProcessSlotStore.ts";

describe("process-slot persistence", () => {
  it("reconciles durable holders concurrently within the configured bound", async () => {
    const first = await fixture();
    await Promise.all(Array.from({ length: 4 }, () => first.acquire()));
    const entered = Promise.withResolvers<void>();
    const stop = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const recovered = fixture({
      store: first.store,
      recoveryConcurrency: 2,
      async reconcile() {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) entered.resolve();
        await stop.promise;
        active--;
        return stopped;
      },
    });
    await entered.promise;
    expect(active).toBe(2);
    stop.resolve();
    await recovered;
    expect(peak).toBe(2);
    expect((await first.store.load())?.slots).toEqual([]);
  });

  it("drops unused generation-zero entries while retaining retired generations", async () => {
    const { slots, acquire, store } = await fixture();
    const held = await Promise.all([acquire(), acquire(), acquire("js")]);
    await slots.lose(held[1]!.lease, "memory");
    await slots.release(held[0]!.lease, stopped);
    await slots.handoff(held[2]!.lease, stopped);
    expect((await store.load())?.slots).toEqual([{ codeId: "bash", index: 1, generation: 1 }]);
    expect((await acquire()).lease.loaderId).toBe(held[0]!.lease.loaderId);
    expect((await acquire()).lease.loaderId).toBe("supervisor/shard-a/bash/1.1");
  });

  it("coalesces observations into the next state change without writes ahead of acquire/release", async () => {
    const { slots, acquire, store } = await fixture();
    const first = await acquire();
    const committed: string[] = [];
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    store.beforeSave = async (state) => {
      committed.push(
        state.slots.some((slot) => slot.holder?.token === first.lease.token)
          ? "acquire"
          : "release",
      );
      entered.resolve();
      await commit.promise;
    };
    const second = acquire("js");
    await entered.promise;
    for (const measurement of [41, 42, 150, 60, 70]) slots.observe(first.lease, measurement);
    const released = slots.release(first.lease, stopped);
    commit.resolve();
    await second;
    await released;
    expect(committed).toEqual(["acquire", "release"]);
  });

  it("persists the latest observation with a later mutation", async () => {
    const { slots, acquire, store } = await fixture();
    const { lease } = await acquire();
    slots.observe(lease, 55);
    slots.observe(lease, 75);
    await acquire("js");
    expect(
      (await store.load())?.slots.find((slot) => slot.holder?.token === lease.token)?.holder
        ?.residentBytes,
    ).toBe(75);
  });

  it("signals the first fence immediately and isolates failing fence listeners", async () => {
    const { slots, acquire, store } = await fixture();
    const { lease } = await acquire();
    slots.signals.onFenced(() => {
      throw new Error("observer failed");
    });
    const listener = vi.fn();
    slots.signals.onFenced(listener);
    expect(slots.signals.fenced).toBe(false);
    store.failure = new Error("loss storage failed");
    await expect(slots.lose(lease, "memory")).rejects.toMatchObject({
      name: "ProcessSlotStorageError",
    });
    expect(slots.signals.fenced).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "ProcessSlotStorageError" }),
    );
    await expect(acquire()).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("retains a pending loss if retiring its generation fails after the loss marker saves", async () => {
    const first = await fixture();
    const { lease } = await first.acquire();
    first.store.beforeSave = async (state) => {
      if (state.slots[0]?.holder === undefined) throw new Error("retirement failed");
    };
    await expect(first.slots.lose(lease, "memory")).rejects.toMatchObject({
      name: "ProcessSlotStorageError",
    });
    const persisted = await first.store.load();
    expect(persisted?.slots[0]?.holder?.lost).toBe("memory");
    const recovered = await fixture({ store: new InMemoryProcessSlotStore(persisted) });
    expect((await recovered.acquire()).lease.loaderId).toBe("supervisor/shard-a/bash/0.1");
  });
});
