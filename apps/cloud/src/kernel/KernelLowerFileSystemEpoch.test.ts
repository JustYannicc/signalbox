import { expect, it } from "vite-plus/test";
import type { KernelLowerFileSystemEntry } from "./KernelLowerFileSystem.ts";
import { KernelLowerFileSystemSourceIndex } from "./KernelLowerFileSystemSourceIndex.ts";

it("does not restore stale positive metadata after lookup has accepted a reply", async () => {
  const reply = Promise.withResolvers<readonly (KernelLowerFileSystemEntry | undefined)[]>();
  const entry: KernelLowerFileSystemEntry = {
    path: "/tool",
    stat: { type: "file", size: 4n, nlink: 1n, atimeNs: 1n, mtimeNs: 1n, ctimeNs: 1n },
    metadata: { mode: 0o755, uid: 0, gid: 0 },
  };
  const index = new KernelLowerFileSystemSourceIndex(
    {
      lookup: () => reply.promise,
      async readdir() {
        throw new Error("Unexpected directory read");
      },
      async readlink() {
        throw new Error("Unexpected link read");
      },
      async read() {
        throw new Error("Unexpected file read");
      },
    },
    () => 1n,
  );
  const lookup = index.lookup("/tool");
  reply.resolve([entry]);
  // Invalidation runs after source acceptance and before lookup's caller receives the inode.
  queueMicrotask(() => index.invalidate());
  expect(await lookup).toBe(1n);
  expect(index.cachedEntry("/tool")).toBeUndefined();
});
