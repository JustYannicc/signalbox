import { vi } from "vite-plus/test";
import { createProcessSlots, type ProcessSlotsOptions } from "../../ProcessSlots.ts";
import { InMemoryProcessSlotStore } from "./InMemoryProcessSlotStore.ts";

export async function fixture(options: Partial<ProcessSlotsOptions> = {}) {
  const quanta = new Set<() => void>();
  const scheduled = Promise.withResolvers<void>();
  const store = new InMemoryProcessSlotStore();
  const invalidate = vi.fn();
  const slots = await createProcessSlots({
    owner: "supervisor/shard-a",
    ioContext: "worker-request",
    residentByteLimit: 100,
    store,
    invalidate,
    scheduleQuantum(callback) {
      quanta.add(callback);
      scheduled.resolve();
      return () => quanta.delete(callback);
    },
    async reconcile() {
      throw new Error("Unexpected durable holder");
    },
    ...options,
  });
  const acquire = (codeId = "bash", residentBytes = 40, signal = new AbortController().signal) =>
    slots.acquire({ owner: options.owner ?? "supervisor/shard-a", codeId, residentBytes, signal });
  const quantum = () => {
    const pending = [...quanta];
    quanta.clear();
    for (const callback of pending) callback();
  };
  return { slots, store, invalidate, acquire, quantum, scheduled: scheduled.promise };
}

export const stopped = { acknowledged: true } as const;

export async function fill(acquire: Awaited<ReturnType<typeof fixture>>["acquire"], count = 4) {
  return await Promise.all(Array.from({ length: count }, () => acquire()));
}
