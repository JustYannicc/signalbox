import { describe, expect, it } from "vite-plus/test";
import { createKernelRevisionWorkspace } from "../../kernel/KernelRevisionWorkspace.ts";
import { kernelFileByteViewStorage } from "../../kernel/KernelLowerFileSystemStorage.ts";
import { base, makeLocalFile, rig } from "./FacetWorkspaceFixture.ts";

describe("revision storage identity through a lower overlay", () => {
  it("resolves an upper inode to its exact persistence backing and checkpoints its bytes", async () => {
    const bytes = new Uint8Array([9, 17, 255]);
    const test = rig([{ path: "/owned", bytes }]);
    makeLocalFile(test.persistence.storage, "/owned", bytes);
    try {
      const resolved = test.filesystem.resolve("/owned");
      expect(resolved.mount.storage).not.toBe(test.persistence.storage);
      expect(kernelFileByteViewStorage(resolved.mount.storage, resolved.inode)).toBe(
        test.persistence.storage,
      );
      const at = await test.workspace.checkpoint("overlay-owned", new AbortController().signal);
      expect(test.ports.inspectTree(at)?.["/owned"]?.data).toEqual(bytes);
    } finally {
      test.close();
    }
  });

  it.each(["backing", "database"] as const)(
    "rejects an unrelated %s with identical inode numbers",
    (kind) => {
      const owner = rig([]);
      const foreign = rig([]);
      const filesystem = kind === "backing" ? foreign.filesystem : owner.filesystem;
      try {
        expect(() =>
          createKernelRevisionWorkspace({
            database: kind === "database" ? foreign.storage : owner.storage,
            persistence: owner.persistence,
            filesystem,
            mountPath: "/",
            initial: base,
          }),
        ).toThrow(expect.objectContaining({ code: "EINVAL" }));
        expect(owner.persistence.storage.stat(owner.persistence.storage.root).type).toBe(
          "directory",
        );
        expect(foreign.persistence.storage.stat(foreign.persistence.storage.root).type).toBe(
          "directory",
        );
      } finally {
        owner.close();
        foreign.close();
      }
    },
  );

  it("rejects a lower-only revision root even when it reports valid directory metadata", () => {
    const test = rig([]);
    const entry = {
      path: "/machine",
      stat: {
        type: "directory" as const,
        size: 0n,
        nlink: 2n,
        atimeNs: 1n,
        mtimeNs: 1n,
        ctimeNs: 1n,
      },
      metadata: { mode: 0o755, uid: 0, gid: 0 },
    };
    const lower = test.filesystem.installLowerFileSystem({
      lookupKnown: (paths) => paths.map((path) => (path === entry.path ? entry : undefined)),
      lookup: (paths) => paths.map((path) => (path === entry.path ? entry : undefined)),
      readdir: async () => [],
      readlink: async () => {
        throw new Error("No symlinks");
      },
      read: async () => new Uint8Array(),
    });
    try {
      const resolved = test.filesystem.resolve("/machine");
      expect(kernelFileByteViewStorage(resolved.mount.storage, resolved.inode)).toBeUndefined();
      expect(() =>
        createKernelRevisionWorkspace({
          database: test.storage,
          persistence: test.persistence,
          filesystem: test.filesystem,
          mountPath: "/machine",
          initial: base,
        }),
      ).toThrow(expect.objectContaining({ code: "EINVAL" }));
    } finally {
      lower.dispose();
      test.close();
    }
  });
});
