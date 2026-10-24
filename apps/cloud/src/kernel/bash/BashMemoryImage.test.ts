import { expect, it } from "vite-plus/test";
import { BASH_SPARSE_MAX_RANGES, type KernelBashForkState } from "../KernelBashFork.ts";
import { bashMemoryChunks, bashMemoryRanges, sparseBashMemoryRanges } from "../KernelBashMemory.ts";

it.each([0, 1])(
  "reconstructs zero holes and coalesces nonzero pages at byte alignment %i",
  (alignment) => {
    const backing = new Uint8Array(4 * 4096 + 5 + alignment);
    const memory = backing.subarray(alignment);
    memory[0] = 1;
    memory[8191] = 2;
    memory[3 * 4096] = 3;
    memory[memory.length - 1] = 4;
    const ranges = sparseBashMemoryRanges(memory);
    expect(ranges).toEqual([
      { offset: 0, length: 8192 },
      { offset: 3 * 4096, length: 4096 + 5 },
    ]);
    const restored = new Uint8Array(memory.length);
    for (const { offset, length } of ranges ?? [])
      restored.set(memory.subarray(offset, offset + length), offset);
    expect(restored).toEqual(memory);
  },
);

it("uses an empty index for zero memory and a bounded dense fallback for fragmentation", () => {
  expect(sparseBashMemoryRanges(new Uint8Array(65_536))).toEqual([]);
  const memory = new Uint8Array((BASH_SPARSE_MAX_RANGES * 2 + 1) * 4096);
  for (let offset = 0; offset < memory.length; offset += 8192) memory[offset] = 1;
  expect(sparseBashMemoryRanges(memory)).toBeUndefined();
});

it("splits coalesced image ranges into bounded transfers without crossing a hole", () => {
  expect([...bashMemoryChunks([{ offset: 4096, length: 65_536 + 4096 }])]).toEqual([
    { offset: 4096, length: 65_536 },
    { offset: 4096 + 65_536, length: 4096 },
  ]);
});

const state: KernelBashForkState = {
  version: 2,
  memoryBytes: 3 * 65_536,
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
  continuation: { resume: 0 },
};

it.each([
  [{ offset: -4096, length: 4096 }],
  [{ offset: 0.5, length: 4096 }],
  [{ offset: 0, length: 0 }],
  [{ offset: 1, length: 4096 }],
  [{ offset: 0, length: 1 }],
  [{ offset: 3 * 65_536, length: 4096 }],
  [{ offset: 0, length: Number.MAX_SAFE_INTEGER }],
  [{ offset: 0, length: Number.NaN }],
  [{ offset: 0, length: Number.POSITIVE_INFINITY }],
  [
    { offset: 8192, length: 8192 },
    { offset: 4096, length: 4096 },
  ],
  [
    { offset: 0, length: 8192 },
    { offset: 4096, length: 4096 },
  ],
  [
    { offset: 0, length: 4096 },
    { offset: 4096, length: 4096 },
  ],
])("rejects malformed sparse ranges %j", (...ranges) => {
  expect(() => bashMemoryRanges({ ...state, memoryRanges: ranges })).toThrow(
    "Invalid sparse Bash checkpoint ranges",
  );
});

it("accepts a partial last page only at the exact declared image boundary", () => {
  const memoryRanges = [{ offset: 4096, length: 5 }];
  expect(bashMemoryRanges({ ...state, memoryBytes: 4101, memoryRanges })).toEqual(memoryRanges);
});
