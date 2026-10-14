import { describe, expect, it } from "@effect/vitest";

import {
  makePreviewLinkRegistryApi,
  type PreviewLinkRegistryStore,
} from "./PreviewLinkRegistry.ts";

const makeStore = (): PreviewLinkRegistryStore => {
  const closed = new Set<string>();
  const pools = new Map<string, Set<string>>();
  return {
    registerPool: (origin, poolId) => {
      if (closed.has(origin)) return false;
      const ids = pools.get(origin) ?? new Set<string>();
      ids.add(poolId);
      pools.set(origin, ids);
      return true;
    },
    includePool: (origin, poolId) => {
      const ids = pools.get(origin) ?? new Set<string>();
      ids.add(poolId);
      pools.set(origin, ids);
    },
    closeOrigin: (origin) => {
      closed.add(origin);
      return [...(pools.get(origin) ?? [])];
    },
    removePool: (origin, poolId) => {
      const ids = pools.get(origin);
      ids?.delete(poolId);
      if (ids?.size === 0) pools.delete(origin);
    },
    activateOrigin: (origin) => closed.delete(origin),
    listOrigins: () => [...pools.keys()].sort(),
  };
};

describe("PreviewLinkRegistry", () => {
  it("retries failed revocations and keeps other preview origins", async () => {
    const store = makeStore();
    const calls: Array<string> = [];
    let failPoolB = true;
    const registry = makePreviewLinkRegistryApi(store, async (poolId, origin) => {
      calls.push(`${poolId}:${origin}`);
      if (poolId === "pool-b" && failPoolB) {
        failPoolB = false;
        throw new Error("Pool unavailable");
      }
      return 1;
    });
    const closed = "https://preview-212.signalbox.run";
    const active = "https://preview-213.signalbox.run";
    await registry.registerPool(closed, "pool-a");
    await registry.registerPool(closed, "pool-b");
    await registry.registerPool(active, "pool-c");

    await expect(registry.cleanupOrigin(closed, ["pool-d"])).rejects.toThrow("Pool unavailable");
    expect(await registry.listOrigins()).toEqual([closed, active]);
    expect(await registry.registerPool(closed, "pool-e")).toBe(false);
    expect(await registry.cleanupOrigin(closed)).toBe(2);
    expect(await registry.listOrigins()).toEqual([active]);
    expect(calls).toEqual([
      `pool-a:${closed}`,
      `pool-b:${closed}`,
      `pool-b:${closed}`,
      `pool-d:${closed}`,
    ]);

    expect(await registry.registerPool(closed, "pool-z")).toBe(false);
    await registry.activateOrigin(closed);
    expect(await registry.registerPool(closed, "pool-z")).toBe(true);

    const reopened = "https://preview-214.signalbox.run";
    await registry.registerPool(reopened, "pool-e");
    store.closeOrigin(reopened);
    expect(await registry.registerPool(reopened, "pool-f")).toBe(false);
    await registry.activateOrigin(reopened);
    expect(await registry.registerPool(reopened, "pool-f")).toBe(true);
  });
});
