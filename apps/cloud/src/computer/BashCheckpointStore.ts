// @effect-diagnostics cryptoRandomUUID:off - anonymous checkpoint inode names must not collide with guest files.
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import {
  BASH_FORK_CHUNK_BYTES,
  copyKernelBashForkState,
  type KernelBashForkSource,
  type KernelBashForkState,
} from "../kernel/KernelBashFork.ts";

export interface BashCheckpoint {
  readonly memoryBytes: number;
  source(transform?: (state: KernelBashForkState) => KernelBashForkState): KernelBashForkSource;
  close(): Promise<void>;
}

/** Anonymous storage inodes keep parked heaps out of the facet's JavaScript heap and guest namespace. */
export async function storeBashCheckpoint(
  filesystem: KernelFileSystem,
  source: KernelBashForkSource,
  signal?: AbortSignal,
): Promise<BashCheckpoint> {
  const stateReply = await source.state();
  let state: KernelBashForkState;
  try {
    state = copyKernelBashForkState(stateReply);
  } finally {
    disposeKernelRpcReply(stateReply);
  }
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(state.memoryBytes) || state.memoryBytes < 0) {
    throw new RangeError("Invalid Bash checkpoint size");
  }
  const resolved = filesystem.resolve(filesystem.cwd);
  const storage = resolved.mount.storage;
  const name = `.signalbox-checkpoint-${crypto.randomUUID()}`;
  const inode = await storage.create(resolved.inode, name, { type: "file", exclusive: true });
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    await storage.release(inode);
  };
  const assertOpen = () => {
    if (!open) throw new Error("Bash checkpoint is closed");
  };
  try {
    await storage.unlink(resolved.inode, name, { directory: false });
    for (let offset = 0; offset < state.memoryBytes; offset += BASH_FORK_CHUNK_BYTES) {
      const length = Math.min(BASH_FORK_CHUNK_BYTES, state.memoryBytes - offset);
      const reply = await source.read(offset, length);
      let chunk: Uint8Array;
      try {
        if (reply.byteLength !== length) throw new Error("Incomplete Bash checkpoint chunk");
        chunk = reply.slice();
      } finally {
        disposeKernelRpcReply(reply);
      }
      let written = 0;
      while (written < length) {
        const count = await storage.write(inode, BigInt(offset + written), chunk.subarray(written));
        if (count < 1 || count > length - written)
          throw new Error("Incomplete Bash checkpoint write");
        written += count;
      }
    }
    await storage.sync(inode, false);
    await source.restored();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    memoryBytes: state.memoryBytes,
    source(transform = (value) => value) {
      assertOpen();
      const restoredState = transform(state);
      return {
        async state() {
          assertOpen();
          return restoredState;
        },
        async read(offset, length) {
          assertOpen();
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length < 1 ||
            length > BASH_FORK_CHUNK_BYTES ||
            offset + length > state.memoryBytes
          )
            throw new RangeError("Invalid Bash checkpoint chunk");
          const bytes = new Uint8Array(length);
          const count = await storage.readInto(inode, BigInt(offset), bytes);
          if (count !== length) throw new Error("Incomplete stored Bash checkpoint chunk");
          return bytes;
        },
        async restored() {
          await close();
        },
      };
    },
    close,
  };
}
