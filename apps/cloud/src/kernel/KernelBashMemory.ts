import {
  BASH_FORK_CHUNK_BYTES,
  BASH_SPARSE_MAX_RANGES,
  type KernelBashForkState,
  type KernelBashMemoryRange,
} from "./KernelBashFork.ts";

export const BASH_SPARSE_PAGE_BYTES = 4096;

/** Fragmented images keep the dense format instead of growing an unbounded RPC index. */
export function sparseBashMemoryRanges(memory: Uint8Array) {
  const ranges: { offset: number; length: number }[] = [];
  const words =
    memory.byteOffset % 4 === 0
      ? new Uint32Array(memory.buffer, memory.byteOffset, Math.floor(memory.byteLength / 4))
      : undefined;
  for (let offset = 0; offset < memory.byteLength; offset += BASH_SPARSE_PAGE_BYTES) {
    const end = Math.min(offset + BASH_SPARSE_PAGE_BYTES, memory.byteLength);
    let nonzero = false;
    let cursor = offset;
    if (words !== undefined) {
      for (; cursor + 4 <= end; cursor += 4) {
        if (words[cursor / 4] !== 0) {
          nonzero = true;
          break;
        }
      }
    }
    if (!nonzero) {
      for (; cursor < end; cursor++) {
        if (memory[cursor] !== 0) {
          nonzero = true;
          break;
        }
      }
    }
    if (!nonzero) continue;
    const previous = ranges.at(-1);
    if (previous !== undefined && previous.offset + previous.length === offset) {
      previous.length = end - previous.offset;
    } else {
      if (ranges.length === BASH_SPARSE_MAX_RANGES) return undefined;
      ranges.push({ offset, length: end - offset });
    }
  }
  return ranges;
}

export function bashMemoryRanges(state: KernelBashForkState): readonly KernelBashMemoryRange[] {
  if (state.version !== 1 && state.version !== 2)
    throw new Error(`Unsupported Bash checkpoint version ${state.version}`);
  if (!Number.isSafeInteger(state.memoryBytes) || state.memoryBytes < 0)
    throw new RangeError("Invalid Bash checkpoint size");
  if (state.version === 1)
    return state.memoryBytes === 0 ? [] : [{ offset: 0, length: state.memoryBytes }];
  const ranges = state.memoryRanges;
  if (!Array.isArray(ranges) || ranges.length > BASH_SPARSE_MAX_RANGES)
    throw new RangeError("Invalid sparse Bash checkpoint ranges");
  let previousEnd = -1;
  for (const range of ranges) {
    if (
      range === null ||
      typeof range !== "object" ||
      !Number.isSafeInteger(range.offset) ||
      !Number.isSafeInteger(range.length) ||
      range.offset < 0 ||
      range.length < 1 ||
      range.offset % BASH_SPARSE_PAGE_BYTES !== 0 ||
      range.offset <= previousEnd ||
      !Number.isSafeInteger(range.offset + range.length) ||
      range.offset + range.length > state.memoryBytes ||
      (range.length % BASH_SPARSE_PAGE_BYTES !== 0 &&
        range.offset + range.length !== state.memoryBytes)
    )
      throw new RangeError("Invalid sparse Bash checkpoint ranges");
    previousEnd = range.offset + range.length;
  }
  return ranges;
}

export function* bashMemoryChunks(ranges: readonly KernelBashMemoryRange[]) {
  for (const range of ranges) {
    for (let offset = range.offset; offset < range.offset + range.length;) {
      const length = Math.min(BASH_FORK_CHUNK_BYTES, range.offset + range.length - offset);
      yield { offset, length };
      offset += length;
    }
  }
}
