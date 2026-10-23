import { describe, expect, it, vi } from "vite-plus/test";
import { ChildHostLease } from "../ChildHostLease.ts";
import { WorkerBashSnapshot } from "../WorkerBashSnapshot.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const state = {
  memoryBytes: 8,
  stackPointer: 0,
  captures: {
    stack: { low: 0, high: 0, log: 0 },
    base: 0,
    size: 0,
    names: [],
    stackNames: [],
    captures: [],
    top: 0,
    liveBytes: 0,
    nextId: 1,
    nextGeneration: 1,
  },
};

describe("worker Bash snapshot", () => {
  it.each(["resolve", "reject"] as const)(
    "releases the source RPC stub when restoration %ss",
    async (outcome) => {
      const lease = new ChildHostLease();
      const failure = new Error("snapshot restore failed");
      const dispose = vi.fn();
      const source = {
        [Symbol.dispose]: dispose,
        state: vi.fn(async () => state),
        read: vi.fn(async () => new Uint8Array([42])),
        restored:
          outcome === "resolve"
            ? vi.fn(async () => {})
            : vi.fn(async () => {
                throw failure;
              }),
      };
      const snapshot = new WorkerBashSnapshot(lease, source);

      await expect(snapshot.state()).resolves.toEqual(state);
      await expect(snapshot.read(0, 1)).resolves.toEqual(new Uint8Array([42]));
      if (outcome === "resolve") await expect(snapshot.restored()).resolves.toBeUndefined();
      else await expect(snapshot.restored()).rejects.toBe(failure);

      expect(source.restored).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(() => snapshot.state()).toThrow(expect.objectContaining({ code: "EBADF" }));
      lease.release();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );
});
