import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerCapacity, type DurableProcessSlotStorage } from "../ChildWorkerCapacity.ts";

function request(codeId: string) {
  return Object.freeze({ codeId, residentBytes: 0 });
}

function durableStorage(): DurableProcessSlotStorage {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      values.set(key, structuredClone(value));
    },
  };
}

describe("ChildWorkerCapacity identities", () => {
  it("keeps warm IDs across capacity reconstruction and retires a lost generation", async () => {
    const storage = durableStorage();
    const owner = "thread/durable-capacity";
    const code = request("durable-code");
    const firstCapacity = new ChildWorkerCapacity(4, { owner, storage });
    const first = await firstCapacity.acquire(new AbortController().signal, undefined, code);
    const firstId = first.execution.loaderId;
    await first.release();

    const reconstructed = new ChildWorkerCapacity(4, { owner, storage });
    const warm = await reconstructed.acquire(new AbortController().signal, undefined, code);
    expect(warm.execution.loaderId).toBe(firstId);
    await warm.execution.lose("memory");
    await warm.release();

    const afterLoss = new ChildWorkerCapacity(4, { owner, storage });
    const fresh = await afterLoss.acquire(new AbortController().signal, undefined, code);
    expect(fresh.execution.loaderId).not.toBe(firstId);
    await fresh.release();
  });

  it("caps four concurrent Worker-context IDs and reuses one only after release", async () => {
    const capacity = new ChildWorkerCapacity(4, { owner: "worker/concurrent-cap-test" });
    const code = request("same-program");
    const running = await Promise.all(
      Array.from({ length: 4 }, () =>
        capacity.acquire(new AbortController().signal, undefined, code),
      ),
    );
    const activeIds = new Set(running.map((permit) => permit.execution.loaderId));
    expect(activeIds.size).toBe(4);
    let fifthSettled = false;
    const fifthPromise = capacity
      .acquire(new AbortController().signal, undefined, code)
      .then((permit) => {
        fifthSettled = true;
        return permit;
      });
    expect(capacity.active).toBe(4);
    expect(capacity.waiting).toBe(1);
    expect(fifthSettled).toBe(false);

    await running[0]!.release();
    const fifth = await fifthPromise;
    expect(fifth.execution.loaderId).toBe(running[0]!.execution.loaderId);
    expect(capacity.active).toBe(4);
    await Promise.all([...running.slice(1).map((permit) => permit.release()), fifth.release()]);
    expect(capacity.active).toBe(0);
  });
});
