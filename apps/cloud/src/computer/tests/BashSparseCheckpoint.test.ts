import { expect, it, vi } from "vite-plus/test";
import type { KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import { storeBashCheckpoint } from "../BashCheckpointStore.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";
import { withRpcReplyDisposer } from "./helpers/rpcReply.ts";

const sparseState = (): KernelBashForkState => ({
  version: 2,
  memoryBytes: 3 * 65_536,
  memoryRanges: [
    { offset: 4096, length: 4096 },
    { offset: 2 * 65_536, length: 4096 },
  ],
  stackPointer: 16,
  continuation: { resume: 42 },
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

it("stores sparse ranges without fetching holes and serves old logical reads with zero holes", async () => {
  const fixture = createTestFilesystem();
  const state = sparseState();
  const first = new Uint8Array(4096).fill(0x51);
  const second = new Uint8Array(4096).fill(0xa7);
  const read = vi.fn(async (offset: number, length: number) => {
    if (length !== 4096 || (offset !== 4096 && offset !== 2 * 65_536))
      throw new Error("Sparse checkpoint fetched a hole");
    const bytes = (offset === 4096 ? first : second).slice();
    return withRpcReplyDisposer(bytes, () => bytes.fill(0));
  });
  const storage = fixture.filesystem.resolve("/").mount.storage;
  const write = vi.spyOn(storage, "write");
  const restored = vi.fn(async () => {});
  try {
    const checkpoint = await storeBashCheckpoint(fixture.filesystem, {
      state: async () => state,
      read,
      restored,
    });
    expect(read.mock.calls).toEqual([
      [4096, 4096],
      [2 * 65_536, 4096],
    ]);
    expect(write.mock.calls.reduce((bytes, call) => bytes + call[2].byteLength, 0)).toBe(8192);
    expect(restored).toHaveBeenCalledOnce();
    const source = checkpoint.source();
    expect(await source.state()).toEqual(state);
    const expected = new Uint8Array(65_536);
    expected.set(first, 4096);
    expect(await source.read(0, expected.length)).toEqual(expected);
    expect(await source.read(65_536, 65_536)).toEqual(new Uint8Array(65_536));
    expect(await source.read(2 * 65_536, 4096)).toEqual(second);
    await checkpoint.close();
  } finally {
    write.mockRestore();
    fixture.close();
  }
});

it("copies sparse metadata before disposal and streams partial storage writes and reads", async () => {
  const fixture = createTestFilesystem();
  const state = sparseState();
  let stateDisposals = 0;
  let chunkDisposals = 0;
  const storage = fixture.filesystem.resolve("/").mount.storage;
  const write = storage.write.bind(storage);
  const readInto = storage.readInto.bind(storage);
  const partialWrite = vi
    .spyOn(storage, "write")
    .mockImplementation(async (inode, offset, bytes) =>
      write(inode, offset, bytes.subarray(0, 97)),
    );
  const partialRead = vi
    .spyOn(storage, "readInto")
    .mockImplementation(async (inode, offset, bytes) =>
      readInto(inode, offset, bytes.subarray(0, 113)),
    );
  try {
    const checkpoint = await storeBashCheckpoint(fixture.filesystem, {
      state: async () =>
        withRpcReplyDisposer(state, () => {
          stateDisposals++;
          const firstRange = state.memoryRanges?.[0];
          if (firstRange === undefined) throw new Error("Sparse fixture lost its first range");
          Object.assign(firstRange, { offset: 0 });
        }),
      read: async (_offset, length) => {
        const bytes = new Uint8Array(length).fill(0x51);
        return withRpcReplyDisposer(bytes, () => {
          chunkDisposals++;
          bytes.fill(0);
        });
      },
      restored: async () => {},
    });
    expect(stateDisposals).toBe(1);
    expect(chunkDisposals).toBe(2);
    expect(await checkpoint.source().read(4096, 4096)).toEqual(new Uint8Array(4096).fill(0x51));
    await checkpoint.close();
  } finally {
    partialWrite.mockRestore();
    partialRead.mockRestore();
    fixture.close();
  }
});

it.each(["short-read", "bad-write", "sync", "abort"])(
  "releases sparse storage without acknowledging a failed %s checkpoint",
  async (failureKind) => {
    const fixture = createTestFilesystem();
    const controller = new AbortController();
    const storage = fixture.filesystem.resolve("/").mount.storage;
    const release = vi.spyOn(storage, "release");
    const restored = vi.fn(async () => {});
    let disposals = 0;
    const write = storage.write.bind(storage);
    const sync = storage.sync.bind(storage);
    const failure = new Error(failureKind);
    const writeSpy = vi.spyOn(storage, "write").mockImplementation(async (inode, offset, bytes) => {
      if (failureKind === "bad-write") return Number.NaN;
      const count = await write(inode, offset, bytes);
      if (failureKind === "abort") controller.abort(failure);
      return count;
    });
    const syncSpy = vi.spyOn(storage, "sync").mockImplementation((inode, dataOnly) => {
      if (failureKind === "sync") throw failure;
      return sync(inode, dataOnly);
    });
    try {
      await expect(
        storeBashCheckpoint(
          fixture.filesystem,
          {
            state: async () => sparseState(),
            read: async (_offset, length) => {
              const bytes = new Uint8Array(failureKind === "short-read" ? length - 1 : length);
              return withRpcReplyDisposer(bytes, () => disposals++);
            },
            restored,
          },
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(disposals).toBeGreaterThan(0);
      expect(restored).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      writeSpy.mockRestore();
      syncSpy.mockRestore();
      release.mockRestore();
      fixture.close();
    }
  },
);

it("does not manufacture zero bytes when selected stored payload is missing", async () => {
  const fixture = createTestFilesystem();
  const storage = fixture.filesystem.resolve("/").mount.storage;
  try {
    const checkpoint = await storeBashCheckpoint(fixture.filesystem, {
      state: async () => sparseState(),
      read: async (_offset, length) => new Uint8Array(length).fill(1),
      restored: async () => {},
    });
    const missing = vi.spyOn(storage, "readInto").mockReturnValueOnce(0);
    try {
      await expect(checkpoint.source().read(4096, 4096)).rejects.toThrow(
        "Incomplete stored Bash checkpoint chunk",
      );
    } finally {
      missing.mockRestore();
      await checkpoint.close();
    }
  } finally {
    fixture.close();
  }
});
