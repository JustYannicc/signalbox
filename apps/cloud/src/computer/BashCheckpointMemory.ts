import type { AsyncStorage, Inode, Storage } from "../kernel/storage.ts";
import {
  BASH_FORK_CHUNK_BYTES,
  type KernelBashForkSource,
  type KernelBashForkState,
} from "../kernel/KernelBashFork.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import { bashMemoryChunks, bashMemoryRanges } from "../kernel/KernelBashMemory.ts";

type ImageStorage = Pick<Storage | AsyncStorage, "write" | "readInto">;

/** Packed payload avoids expanding a 4 KiB selected page into a 64 KiB filesystem hole. */
export function createBashCheckpointMemory(
  storage: ImageStorage,
  inode: Inode,
  state: KernelBashForkState,
) {
  let payloadBytes = 0;
  const ranges = bashMemoryRanges(state).map((range) => {
    const saved = { ...range, payloadOffset: payloadBytes };
    payloadBytes += range.length;
    return saved;
  });

  async function writeAll(offset: number, bytes: Uint8Array, signal?: AbortSignal) {
    let written = 0;
    while (written < bytes.length) {
      signal?.throwIfAborted();
      const count = await storage.write(inode, BigInt(offset + written), bytes.subarray(written));
      if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - written)
        throw new Error("Incomplete Bash checkpoint write");
      written += count;
    }
    signal?.throwIfAborted();
  }

  async function readAll(offset: number, bytes: Uint8Array) {
    let read = 0;
    while (read < bytes.length) {
      const count = await storage.readInto(inode, BigInt(offset + read), bytes.subarray(read));
      if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - read)
        throw new Error("Incomplete stored Bash checkpoint chunk");
      read += count;
    }
  }

  return {
    async write(source: KernelBashForkSource, signal?: AbortSignal) {
      const packed = state.version === 2 ? new Uint8Array(BASH_FORK_CHUNK_BYTES) : undefined;
      let buffered = 0;
      let payloadOffset = 0;
      for (const { offset, length } of bashMemoryChunks(ranges)) {
        signal?.throwIfAborted();
        const reply = await source.read(offset, length);
        let bytes: Uint8Array;
        try {
          if (reply.byteLength !== length) throw new Error("Incomplete Bash checkpoint chunk");
          bytes = reply.slice();
        } finally {
          disposeKernelRpcReply(reply);
        }
        signal?.throwIfAborted();
        if (packed === undefined) {
          await writeAll(offset, bytes, signal);
          continue;
        }
        let consumed = 0;
        while (consumed < bytes.length) {
          const count = Math.min(packed.length - buffered, bytes.length - consumed);
          packed.set(bytes.subarray(consumed, consumed + count), buffered);
          buffered += count;
          consumed += count;
          if (buffered === packed.length) {
            await writeAll(payloadOffset, packed, signal);
            payloadOffset += buffered;
            buffered = 0;
          }
        }
      }
      if (packed !== undefined && buffered > 0)
        await writeAll(payloadOffset, packed.subarray(0, buffered), signal);
    },
    async read(offset: number, length: number) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > BASH_FORK_CHUNK_BYTES ||
        !Number.isSafeInteger(offset + length) ||
        offset + length > state.memoryBytes
      )
        throw new RangeError("Invalid Bash checkpoint chunk");
      const bytes = new Uint8Array(length);
      for (const range of ranges) {
        const start = Math.max(offset, range.offset);
        const end = Math.min(offset + length, range.offset + range.length);
        if (start >= end) continue;
        await readAll(
          range.payloadOffset + start - range.offset,
          bytes.subarray(start - offset, end - offset),
        );
      }
      return bytes;
    },
  };
}
