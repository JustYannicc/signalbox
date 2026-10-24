import { describe, expect, it, vi } from "vite-plus/test";
import { storeBashCheckpoint } from "../BashCheckpointStore.ts";
import { BASH_FORK_CHUNK_BYTES, type KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";
import { withRpcReplyDisposer } from "./helpers/rpcReply.ts";

const state = (memoryBytes: number): KernelBashForkState => ({
  version: 1,
  memoryBytes,
  stackPointer: 16,
  continuation: { resume: 0 },
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
});

describe("Bash checkpoint backing", () => {
  it("preserves cancellation when the filesystem closes while checkpoint state is pending", async () => {
    const fixture = createTestFilesystem();
    const controller = new AbortController();
    const captured = Promise.withResolvers<KernelBashForkState>();
    const cancelled = new Error("Checkpoint owner stopped");
    let disposeCount = 0;
    const checkpoint = storeBashCheckpoint(
      fixture.filesystem,
      {
        state: () => captured.promise,
        read: async () => new Uint8Array(),
        restored: async () => {},
      },
      controller.signal,
    );
    controller.abort(cancelled);
    fixture.close();
    captured.resolve(withRpcReplyDisposer(state(0), () => disposeCount++));
    await expect(checkpoint).rejects.toBe(cancelled);
    expect(disposeCount).toBe(1);
  });

  it("disposes invalid checkpoint metadata before rejecting it", async () => {
    const fixture = createTestFilesystem();
    let disposeCount = 0;
    const invalid = withRpcReplyDisposer(state(-1), () => disposeCount++);
    try {
      await expect(
        storeBashCheckpoint(fixture.filesystem, {
          state: async () => invalid,
          read: async () => new Uint8Array(),
          restored: async () => {},
        }),
      ).rejects.toThrow("Invalid Bash checkpoint size");
      expect(disposeCount).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it("streams an immutable heap through bounded reads without exposing a file or guest fd", async () => {
    const fixture = createTestFilesystem();
    const original = new Uint8Array(BASH_FORK_CHUNK_BYTES * 3 + 17);
    for (let index = 0; index < original.length; index++) original[index] = index % 251;
    const expected = original.slice();
    const reads: number[] = [];
    let stateDisposals = 0;
    let chunkDisposals = 0;
    let copied = false;
    const beforeEntries = fixture.filesystem.readdir("/");
    const beforeDescriptors = [...fixture.filesystem.descriptors.entries()].length;
    try {
      const checkpoint = await storeBashCheckpoint(fixture.filesystem, {
        async state() {
          const reply = state(original.byteLength);
          return withRpcReplyDisposer(reply, () => {
            stateDisposals++;
            Object.assign(reply, { memoryBytes: 0 });
          });
        },
        async read(offset, length) {
          reads.push(length);
          const chunk = original.slice(offset, offset + length);
          return withRpcReplyDisposer(chunk, () => {
            chunkDisposals++;
            chunk.fill(0);
          });
        },
        async restored() {
          copied = true;
        },
      });
      expect(copied).toBe(true);
      expect(stateDisposals).toBe(1);
      expect(chunkDisposals).toBe(4);
      expect(reads).toEqual([
        BASH_FORK_CHUNK_BYTES,
        BASH_FORK_CHUNK_BYTES,
        BASH_FORK_CHUNK_BYTES,
        17,
      ]);
      expect(fixture.filesystem.readdir("/")).toEqual(beforeEntries);
      expect([...fixture.filesystem.descriptors.entries()]).toHaveLength(beforeDescriptors);
      original.fill(0);
      const source = checkpoint.source();
      const savedState = await source.state();
      expect(savedState).toEqual(state(expected.byteLength));
      expect(Symbol.dispose in savedState).toBe(false);
      for (let offset = 0; offset < expected.length; offset += BASH_FORK_CHUNK_BYTES) {
        const length = Math.min(BASH_FORK_CHUNK_BYTES, expected.length - offset);
        expect(await source.read(offset, length)).toEqual(
          expected.subarray(offset, offset + length),
        );
      }
      await source.restored();
      await expect(source.read(0, 1)).rejects.toThrow("closed");
    } finally {
      fixture.close();
    }
  });

  it("disposes copied chunks and metadata when backing storage fails", async () => {
    const fixture = createTestFilesystem();
    const failure = new Error("checkpoint write failed");
    const stateReply = state(4);
    const chunk = new Uint8Array([1, 2, 3, 4]);
    let stateDisposals = 0;
    let chunkDisposals = 0;
    const restored = vi.fn(async () => {});
    const storage = fixture.filesystem.resolve(fixture.filesystem.cwd).mount.storage;
    const write = vi.spyOn(storage, "write").mockRejectedValueOnce(failure);
    try {
      await expect(
        storeBashCheckpoint(fixture.filesystem, {
          state: async () => withRpcReplyDisposer(stateReply, () => stateDisposals++),
          read: async () =>
            withRpcReplyDisposer(chunk, () => {
              chunkDisposals++;
              chunk.fill(0);
            }),
          restored,
        }),
      ).rejects.toBe(failure);
      expect(stateDisposals).toBe(1);
      expect(chunkDisposals).toBe(1);
      expect(restored).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      fixture.close();
    }
  });

  it("disposes a chunk reply when copying its bytes fails", async () => {
    const fixture = createTestFilesystem();
    const failure = new Error("checkpoint chunk copy failed");
    const chunk = new Uint8Array([1, 2, 3, 4]);
    Object.defineProperty(chunk, "slice", {
      value: () => {
        throw failure;
      },
    });
    const stateDispose = vi.fn();
    const chunkDispose = vi.fn();
    const restored = vi.fn(async () => {});
    try {
      await expect(
        storeBashCheckpoint(fixture.filesystem, {
          state: async () => withRpcReplyDisposer(state(4), stateDispose),
          read: async () => withRpcReplyDisposer(chunk, chunkDispose),
          restored,
        }),
      ).rejects.toBe(failure);
      expect(stateDispose).toHaveBeenCalledOnce();
      expect(chunkDispose).toHaveBeenCalledOnce();
      expect(restored).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });
});
