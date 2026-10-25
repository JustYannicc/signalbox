import { expect, it, vi } from "vite-plus/test";
import { storeBashCheckpoint } from "../BashCheckpointStore.ts";
import type { KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import { KernelFileSystemUnavailable } from "../../kernel/KernelLowerFileSystem.ts";
import { kernelFileByteViewStorage } from "../../kernel/KernelLowerFileSystemStorage.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

it("keeps checkpoint backing local when a machine overlay is disconnected", async () => {
  const fixture = createTestFilesystem();
  fixture.filesystem.mkdir("/workspace");
  fixture.filesystem.chdir("/workspace");
  const mounted = fixture.filesystem.resolve("/");
  const storage = kernelFileByteViewStorage(mounted.mount.storage, mounted.inode);
  if (storage === undefined) throw new Error("Expected local checkpoint backing");
  const before = await storage.readdir(storage.root);
  const failure = new KernelFileSystemUnavailable("Machine is disconnected");
  const lookup = vi.fn(async () => {
    throw failure;
  });
  const overlay = fixture.filesystem.installLowerFileSystem({
    lookup,
    readdir: async () => [],
    readlink: async () => {
      throw failure;
    },
    read: async () => {
      throw failure;
    },
  });
  const state: KernelBashForkState = {
    version: 1,
    memoryBytes: 4,
    stackPointer: 0,
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
  };
  const restored = vi.fn(async () => {});
  let checkpoint: Awaited<ReturnType<typeof storeBashCheckpoint>> | undefined;
  try {
    checkpoint = await storeBashCheckpoint(fixture.filesystem, {
      state: async () => state,
      read: async () => new Uint8Array([4, 6, 2, 7]),
      restored,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(restored).toHaveBeenCalledOnce();
    expect(await storage.readdir(storage.root)).toEqual(before);
    expect(await checkpoint.source().read(0, 4)).toEqual(new Uint8Array([4, 6, 2, 7]));
    await expect(fixture.filesystem.prepareLowerPaths(["/machine-only"])).rejects.toBe(failure);
    expect(lookup).toHaveBeenCalledOnce();
  } finally {
    await checkpoint?.close();
    overlay.dispose();
    fixture.close();
  }
});
