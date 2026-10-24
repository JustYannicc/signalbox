import type { BashCaptureState } from "./bash/BashCaptureState.ts";
import type { KernelBashCheckpointContinuation } from "./KernelBashCheckpoint.ts";

export const BASH_FORK_CHUNK_BYTES = 64 * 1024;
export const BASH_SPARSE_MAX_RANGES = 1024;

export interface KernelBashMemoryRange {
  readonly offset: number;
  readonly length: number;
}

export interface KernelBashForkState {
  readonly version: 1 | 2;
  readonly memoryBytes: number;
  readonly memoryRanges?: readonly KernelBashMemoryRange[];
  readonly stackPointer: number;
  readonly captures: BashCaptureState;
  readonly continuation: KernelBashCheckpointContinuation;
}

/** Checkpoint metadata must survive releasing the transport reply that supplied it. */
export function copyKernelBashForkState(state: KernelBashForkState): KernelBashForkState {
  return {
    version: state.version,
    memoryBytes: state.memoryBytes,
    ...(state.version === 2 ? { memoryRanges: copyMemoryRanges(state.memoryRanges) } : {}),
    stackPointer: state.stackPointer,
    captures: structuredClone(state.captures),
    continuation: structuredClone(state.continuation),
  };
}

function copyMemoryRanges(ranges: KernelBashForkState["memoryRanges"]) {
  if (!Array.isArray(ranges) || ranges.length > BASH_SPARSE_MAX_RANGES)
    throw new RangeError("Invalid sparse Bash checkpoint ranges");
  return ranges.map((range) => {
    if (range === null || typeof range !== "object")
      throw new RangeError("Invalid sparse Bash checkpoint ranges");
    return { offset: range.offset, length: range.length };
  });
}

/** The parent stays suspended until restored, so reads need no second full memory image. */
export interface KernelBashForkSource {
  state(): Promise<KernelBashForkState>;
  read(offset: number, length: number): Promise<Uint8Array>;
  restored(): Promise<void>;
}
