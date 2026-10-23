import { describe, expect, it } from "vite-plus/test";
import { storeBashCheckpoint } from "../BashCheckpointStore.ts";
import { BASH_FORK_CHUNK_BYTES, type KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

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
  it("streams an immutable heap through bounded reads without exposing a file or guest fd", async () => {
    const fixture = createTestFilesystem();
    const original = new Uint8Array(BASH_FORK_CHUNK_BYTES * 3 + 17);
    for (let index = 0; index < original.length; index++) original[index] = index % 251;
    const expected = original.slice();
    const reads: number[] = [];
    let copied = false;
    const beforeEntries = fixture.filesystem.readdir("/");
    const beforeDescriptors = [...fixture.filesystem.descriptors.entries()].length;
    try {
      const checkpoint = await storeBashCheckpoint(fixture.filesystem, {
        state: async () => state(original.byteLength),
        async read(offset, length) {
          reads.push(length);
          return original.slice(offset, offset + length);
        },
        async restored() {
          copied = true;
        },
      });
      expect(copied).toBe(true);
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
});
