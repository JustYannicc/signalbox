import { describe, expect, it } from "vite-plus/test";
import { createProcessSlots } from "../../ProcessSlots.ts";
import { InMemoryProcessSlotStore } from "./InMemoryProcessSlotStore.ts";
import { fixture, stopped } from "./fixture.ts";

describe("durable process slots", () => {
  it("publishes no lease until its save commits", async () => {
    const { slots, acquire, store } = await fixture();
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    store.beforeSave = async () => {
      entered.resolve();
      await commit.promise;
    };
    const pending = acquire();
    await entered.promise;
    expect(slots.signals.resident).toBe(0);
    expect(await store.load()).toBeUndefined();
    commit.resolve();
    const { lease } = await pending;
    expect((await store.load())?.slots[0]?.holder?.token).toBe(lease.token);
    expect(slots.signals.inFlight).toBe(1);
  });

  it("rejects save failure as storage failure without exposing or leaking a lease", async () => {
    const { slots, acquire, store } = await fixture();
    const failure = new Error("disk unavailable");
    store.failure = failure;
    await expect(acquire()).rejects.toMatchObject({
      name: "ProcessSlotStorageError",
      cause: failure,
    });
    expect(slots.signals.resident).toBe(0);
    expect(slots.signals.inFlight).toBe(0);
    expect(slots.signals.waiting).toBe(0);
    expect(await store.load()).toBeUndefined();
    store.failure = undefined;
    expect((await acquire()).lease.loaderId).toBe("supervisor/shard-a/bash/0.0");
  });

  it("rejects an already-aborted acquire without saving", async () => {
    const { slots, acquire, store } = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(acquire("bash", 40, abort.signal)).rejects.toBe(abort.signal.reason);
    expect(slots.signals.resident).toBe(0);
    expect(await store.load()).toBeUndefined();
  });

  it("rolls back an acquire aborted during its save before rejecting", async () => {
    const { slots, acquire, store } = await fixture();
    const entered = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    store.beforeSave = async () => {
      entered.resolve();
      await commit.promise;
    };
    const abort = new AbortController();
    const pending = acquire("bash", 40, abort.signal);
    await entered.promise;
    abort.abort();
    const rejected = expect(pending).rejects.toBe(abort.signal.reason);
    commit.resolve();
    await rejected;
    expect(slots.signals.resident).toBe(0);
    expect((await store.load())?.slots.some((slot) => slot.holder !== undefined)).toBe(false);
    expect((await acquire()).lease.loaderId).toBe("supervisor/shard-a/bash/0.0");
  });

  it.each(["release", "handoff", "lose"] as const)(
    "retains the durable holder when %s fails to save",
    async (operation) => {
      const { slots, acquire, store, invalidate } = await fixture();
      const { lease } = await acquire();
      store.failure = new Error("save refused");
      const pending =
        operation === "lose" ? slots.lose(lease, "memory") : slots[operation](lease, stopped);
      await expect(pending).rejects.toMatchObject({ name: "ProcessSlotStorageError" });
      expect(slots.signals.resident).toBe(1);
      expect(slots.signals.inFlight).toBe(1);
      expect((await store.load())?.slots[0]?.holder?.token).toBe(lease.token);
      expect(invalidate).not.toHaveBeenCalled();
      store.failure = undefined;
      if (operation !== "lose") await slots.release(lease, stopped);
    },
  );

  it.each(["stopped", "memory"] as const)(
    "reconciles durable live holders as %s before reusing their indices",
    async (outcome) => {
      const first = await fixture();
      const { lease } = await first.acquire();
      const state = await first.store.load();
      const store = new InMemoryProcessSlotStore(state);
      const reconciled = Promise.withResolvers<void>();
      const ack = Promise.withResolvers<void>();
      const restarted = fixture({
        store,
        async reconcile(holder) {
          expect(holder.token).toBe(lease.token);
          expect(holder.loaderId).toBe(lease.loaderId);
          reconciled.resolve();
          await ack.promise;
          return outcome === "stopped" ? stopped : { lost: "memory" };
        },
      });
      await reconciled.promise;
      expect((await store.load())?.slots[0]?.holder?.token).toBe(lease.token);
      ack.resolve();
      const next = await restarted;
      const replacement = await next.acquire();
      expect(replacement.lease.loaderId).toBe(
        `supervisor/shard-a/bash/0.${outcome === "memory" ? 1 : 0}`,
      );
      expect(replacement.lease.token).not.toBe(lease.token);
    },
  );

  it("rejects load failures and cross-owner recovery", async () => {
    const first = await fixture();
    await first.acquire();
    await expect(fixture({ store: first.store, owner: "different/shard" })).rejects.toThrow(
      /owner/i,
    );
    const failure = new Error("load refused");
    await expect(
      createProcessSlots({
        owner: "supervisor/shard",
        ioContext: "worker-request",
        residentByteLimit: 100,
        store: {
          load: async () => {
            throw failure;
          },
          save: async () => {},
        },
        invalidate() {},
        scheduleQuantum: () => () => {},
        reconcile: async () => stopped,
      }),
    ).rejects.toMatchObject({ name: "ProcessSlotStorageError", cause: failure });
  });
});
