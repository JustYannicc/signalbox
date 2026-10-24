// @effect-diagnostics cryptoRandomUUID:off - anonymous checkpoint inode names must not collide with guest files.
import type { KernelFileSystem } from "../kernel/KernelFileSystem.ts";
import { disposeKernelRpcReply } from "../kernel/KernelRpcReply.ts";
import {
  copyKernelBashForkState,
  type KernelBashForkSource,
  type KernelBashForkState,
} from "../kernel/KernelBashFork.ts";
import { bashMemoryRanges } from "../kernel/KernelBashMemory.ts";
import { createBashCheckpointMemory } from "./BashCheckpointMemory.ts";

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
  bashMemoryRanges(state);
  const resolved = filesystem.resolve(filesystem.cwd);
  const storage = resolved.mount.storage;
  const name = `.signalbox-checkpoint-${crypto.randomUUID()}`;
  const inode = await storage.create(resolved.inode, name, { type: "file", exclusive: true });
  const memory = createBashCheckpointMemory(storage, inode, state);
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
    await memory.write(source, signal);
    await storage.sync(inode, false);
    signal?.throwIfAborted();
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
          return memory.read(offset, length);
        },
        async restored() {
          await close();
        },
      };
    },
    close,
  };
}
