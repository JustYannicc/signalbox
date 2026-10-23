import {
  BASH_FORK_CHUNK_BYTES,
  type KernelBashForkSource,
  type KernelBashForkState,
} from "../KernelBashFork.ts";
import { BashCaptureStore } from "./BashCaptureStore.ts";
import type { BashContinuation } from "./BashTransitions.ts";

export function createBashForkSnapshot(process: BashContinuation) {
  let memory: WebAssembly.Memory | undefined = process.exports.memory;
  const state: KernelBashForkState = {
    memoryBytes: memory.buffer.byteLength,
    stackPointer: Number(process.exports.__stack_pointer.value),
    captures: process.captures.snapshot(),
  };
  const copied = Promise.withResolvers<void>();
  const source: KernelBashForkSource = {
    async state() {
      if (memory === undefined) throw new Error("Bash fork snapshot has already been restored");
      return state;
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

export async function restoreBashFork(process: BashContinuation, source: KernelBashForkSource) {
  const state = await source.state();
  const memory = process.exports.memory;
  if (memory.buffer.byteLength < state.memoryBytes)
    memory.grow((state.memoryBytes - memory.buffer.byteLength) / 65_536);
  for (let offset = 0; offset < state.memoryBytes; offset += BASH_FORK_CHUNK_BYTES) {
    const length = Math.min(BASH_FORK_CHUNK_BYTES, state.memoryBytes - offset);
    const chunk = await source.read(offset, length);
    if (chunk.byteLength !== length) throw new Error("Incomplete Bash fork snapshot chunk");
    new Uint8Array(memory.buffer, offset, length).set(chunk);
  }
  process.exports.__stack_pointer.value = state.stackPointer;
  process.captures = BashCaptureStore.restore(state.captures);
}
