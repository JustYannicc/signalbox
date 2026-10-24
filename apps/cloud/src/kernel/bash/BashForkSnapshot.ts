import {
  BASH_FORK_CHUNK_BYTES,
  copyKernelBashForkState,
  type KernelBashForkSource,
  type KernelBashForkState,
} from "../KernelBashFork.ts";
import { BashCaptureStore } from "./BashCaptureStore.ts";
import type { BashContinuation } from "./BashTransitions.ts";
import type { KernelBashCheckpointContinuation } from "../KernelBashCheckpoint.ts";
import { disposeKernelRpcReply } from "../KernelRpcReply.ts";
import { bashMemoryChunks, bashMemoryRanges, sparseBashMemoryRanges } from "../KernelBashMemory.ts";

export function createBashForkSnapshot(
  process: BashContinuation,
  continuation: KernelBashCheckpointContinuation = continuationFor(process),
) {
  let memory: WebAssembly.Memory | undefined = process.exports.memory;
  const state: KernelBashForkState = {
    version: 1,
    memoryBytes: memory.buffer.byteLength,
    stackPointer: Number(process.exports.__stack_pointer.value),
    captures: process.captures.snapshot(),
    continuation,
  };
  const copied = Promise.withResolvers<void>();
  let image: KernelBashForkState | undefined;
  const source: KernelBashForkSource = {
    async state() {
      if (memory === undefined) throw new Error("Bash fork snapshot has already been restored");
      if (image === undefined) {
        const memoryRanges = sparseBashMemoryRanges(new Uint8Array(memory.buffer));
        image = memoryRanges === undefined ? state : { ...state, version: 2, memoryRanges };
      }
      return image;
    },
    async read(offset, length) {
      if (memory === undefined) throw new Error("Bash fork snapshot has already been restored");
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > BASH_FORK_CHUNK_BYTES ||
        offset + length > state.memoryBytes
      )
        throw new RangeError("Invalid Bash fork snapshot chunk");
      return new Uint8Array(memory.buffer, offset, length).slice();
    },
    async restored() {
      memory = undefined;
      copied.resolve();
    },
  };
  return {
    source,
    copied: copied.promise,
    discard: () => {
      memory = undefined;
    },
  };
}

export async function restoreBashFork(
  process: BashContinuation,
  source: KernelBashForkSource,
): Promise<KernelBashCheckpointContinuation> {
  const stateReply = await source.state();
  let state: KernelBashForkState;
  try {
    state = copyKernelBashForkState(stateReply);
  } finally {
    disposeKernelRpcReply(stateReply);
  }
  const ranges = bashMemoryRanges(state);
  const memory = process.exports.memory;
  if (
    state.version === 2 &&
    (state.memoryBytes % 65_536 !== 0 || memory.buffer.byteLength > state.memoryBytes)
  )
    throw new RangeError("Sparse Bash checkpoint requires an exactly sized guest memory");
  if (memory.buffer.byteLength < state.memoryBytes)
    memory.grow((state.memoryBytes - memory.buffer.byteLength) / 65_536);
  if (state.version === 2) new Uint8Array(memory.buffer).fill(0);
  for (const { offset, length } of bashMemoryChunks(ranges)) {
    const reply = await source.read(offset, length);
    let chunk: Uint8Array;
    try {
      if (reply.byteLength !== length) throw new Error("Incomplete Bash fork snapshot chunk");
      chunk = reply.slice();
    } finally {
      disposeKernelRpcReply(reply);
    }
    new Uint8Array(memory.buffer, offset, length).set(chunk);
  }
  process.exports.__stack_pointer.value = state.stackPointer;
  process.captures = BashCaptureStore.restore(state.captures);
  return state.continuation;
}

function continuationFor(process: BashContinuation): KernelBashCheckpointContinuation {
  const pending = process.pending;
  if (pending?.kind === "operation") {
    return {
      resume: process.resume,
      pending: { kind: "operation", operation: pending.operation, call: pending.call },
    };
  }
  if (pending?.kind === "fork") {
    return {
      resume: process.resume,
      pending: {
        kind: "fork",
        role: "child",
        call: { namespace: "nimbus_proc", name: "fork", args: [] },
      },
    };
  }
  throw new Error("A Bash checkpoint needs a pending syscall or fork continuation");
}
