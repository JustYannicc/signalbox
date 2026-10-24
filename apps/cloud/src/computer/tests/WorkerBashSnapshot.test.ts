import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import { ChildHostLease } from "../ChildHostLease.ts";
import { ChildBashForkSource } from "../ChildBashForkSource.ts";
import { WorkerBashSnapshot } from "../WorkerBashSnapshot.ts";
import { withRpcReplyDisposer } from "./helpers/rpcReply.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const state = {
  version: 1,
  continuation: { resume: 0 },
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
} satisfies KernelBashForkState;

describe("worker Bash snapshot", () => {
  it.each(["resolve", "reject"] as const)(
    "releases the source RPC stub when restoration %ss",
    async (outcome) => {
      const lease = new ChildHostLease();
      const failure = new Error("snapshot restore failed");
      const dispose = vi.fn();
      const stateReplyDispose = vi.fn();
      const chunkReplyDispose = vi.fn();
      const stateReply = { ...state, continuation: { ...state.continuation } };
      const source = {
        [Symbol.dispose]: dispose,
        state: vi.fn(async () =>
          withRpcReplyDisposer(stateReply, () => {
            stateReplyDispose();
            Object.assign(stateReply, { memoryBytes: 0 });
            Object.assign(stateReply.continuation, { resume: 999 });
          }),
        ),
        read: vi.fn(async () => {
          const chunk = new Uint8Array([42]);
          return withRpcReplyDisposer(chunk, () => {
            chunkReplyDispose();
            chunk.fill(0);
          });
        }),
        restored:
          outcome === "resolve"
            ? vi.fn(async () => {})
            : vi.fn(async () => {
                throw failure;
              }),
      };
      const snapshot = new WorkerBashSnapshot(lease, source);

      const copiedState = await snapshot.state();
      expect(copiedState).toEqual(state);
      expect(Symbol.dispose in copiedState).toBe(false);
      expect(stateReplyDispose).toHaveBeenCalledOnce();
      const copiedChunk = await snapshot.read(0, 1);
      expect(copiedChunk).toEqual(new Uint8Array([42]));
      expect(chunkReplyDispose).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      if (outcome === "resolve") await expect(snapshot.restored()).resolves.toBeUndefined();
      else await expect(snapshot.restored()).rejects.toBe(failure);

      expect(source.restored).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      await expect(snapshot.state()).rejects.toMatchObject({ code: "EBADF" });
      lease.release();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("forwards a child source reply without taking its ownership", async () => {
    const stateReplyDispose = vi.fn();
    const chunkReplyDispose = vi.fn();
    const stateReply = withRpcReplyDisposer({ ...state }, stateReplyDispose);
    const chunkReply = withRpcReplyDisposer(new Uint8Array([8, 9]), chunkReplyDispose);
    const source = new ChildBashForkSource({
      state: async () => stateReply,
      read: async () => chunkReply,
      restored: async () => {},
    });

    expect(await source.state()).toBe(stateReply);
    expect(await source.read(0, 2)).toBe(chunkReply);
    expect(stateReplyDispose).not.toHaveBeenCalled();
    expect(chunkReplyDispose).not.toHaveBeenCalled();
  });

  it("disposes a chunk reply when the bounded copy fails", async () => {
    const lease = new ChildHostLease();
    const failure = new Error("snapshot chunk copy failed");
    const disposeSource = vi.fn();
    const disposeChunk = vi.fn();
    const chunk = new Uint8Array([42]);
    Object.defineProperty(chunk, "slice", {
      value: () => {
        throw failure;
      },
    });
    const source = {
      [Symbol.dispose]: disposeSource,
      state: async () => state,
      read: async () => withRpcReplyDisposer(chunk, disposeChunk),
      restored: async () => {},
    };
    const snapshot = new WorkerBashSnapshot(lease, source);

    await expect(snapshot.read(0, 1)).rejects.toBe(failure);
    expect(disposeChunk).toHaveBeenCalledOnce();
    expect(disposeSource).not.toHaveBeenCalled();
    lease.release();
    expect(disposeSource).toHaveBeenCalledOnce();
  });
});
