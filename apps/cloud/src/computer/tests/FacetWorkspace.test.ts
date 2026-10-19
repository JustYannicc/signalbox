import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { CommitInode } from "../../kernel/FilePersistencePorts.ts";
import { commitPort, fileChange, makeLocalFile, rig } from "./FacetWorkspaceFixture.ts";

describe("facet live filesystem revisions", () => {
  it("commits changed bytes and namespace metadata without flattening hard links", async () => {
    const oldBytes = new Uint8Array([1, 2]);
    const goneBytes = new Uint8Array([3]);
    const fixture = rig([
      { path: "/file", bytes: oldBytes },
      { path: "/gone", bytes: goneBytes },
    ]);
    try {
      const file = makeLocalFile(fixture.persistence.storage, "/file", oldBytes);
      makeLocalFile(fixture.persistence.storage, "/gone", goneBytes);
      const before = await fixture.workspace.checkpoint(
        "command-before",
        new AbortController().signal,
      );
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      fixture.filesystem.write(fd, new Uint8Array([9, 8]), 0n);
      fixture.filesystem.rename("/file", "/renamed");
      fixture.filesystem.link("/renamed", "/alias");
      fixture.filesystem.symlink("renamed", "/link");
      fixture.filesystem.unlink("/gone");
      fixture.persistence.storage.posix.chmod(file, 0o600);

      const after = await fixture.workspace.checkpoint(
        "command-after",
        new AbortController().signal,
      );
      const tree = fixture.ports.inspectTree(after)!;
      expect(tree["/file"]).toBeUndefined();
      expect(tree["/gone"]).toBeUndefined();
      expect(tree["/renamed"]?.data).toEqual(new Uint8Array([9, 8]));
      expect(tree["/alias"]?.data).toEqual(new Uint8Array([9, 8]));
      expect(tree["/renamed"]?.posix).toEqual({ mode: 0o600, uid: 1000, gid: 1000 });
      expect(tree["/link"]).toMatchObject({ symlinkTarget: "renamed", stat: { type: "symlink" } });
      expect(after.commit).not.toBe(before.commit);
      expect(fixture.filesystem.fstat(fd).ino).toBe(file);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });

  it("applies a machine revision into the same inode and keeps an after revision on divergence", async () => {
    const oldBytes = new Uint8Array([1, 2]);
    const goneBytes = new Uint8Array([3]);
    const fixture = rig([
      { path: "/file", bytes: oldBytes },
      { path: "/gone", bytes: goneBytes },
    ]);
    try {
      const file = makeLocalFile(fixture.persistence.storage, "/file", oldBytes);
      const gone = makeLocalFile(fixture.persistence.storage, "/gone", goneBytes);
      const before = await fixture.workspace.checkpoint(
        "apply-before",
        new AbortController().signal,
      );
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      const goneFd = fixture.filesystem.open("/gone", KernelOpenFlags.O_RDONLY);
      const machineFile = fileChange(
        50n,
        ["/renamed", "/alias"],
        ["/file"],
        new Uint8Array([7, 8, 9]),
      );
      const symlink: CommitInode = {
        inode: 51n,
        paths: ["/link"],
        removedPaths: [],
        stat: { type: "symlink", size: 7n, nlink: 1n, atimeNs: 20n, mtimeNs: 21n, ctimeNs: 22n },
        symlinkTarget: "renamed",
        posix: null,
        async *readChunks() {},
      };
      const deletion: CommitInode = {
        inode: 52n,
        paths: [],
        removedPaths: ["/gone"],
        stat: null,
        symlinkTarget: null,
        posix: null,
        async *readChunks() {},
      };
      const changed = [machineFile, symlink, deletion];
      const result = await commitPort(fixture.ports).commit({
        at: before,
        turnId: "machine-after",
        changedInodes: changed,
        signal: new AbortController().signal,
      });
      if (result.status === "error") throw new Error(result.error.message);
      const after = { ...before, commit: result.value.commit };
      expect(after.commit).not.toBe(before.commit);
      expect(
        [...fixture.storage.sql.exec("SELECT commit_id FROM kernel_fs_workspace_state")][0]
          ?.commit_id,
      ).toBe(before.commit);

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: changed,
        hydration: fixture.ports.hydration,
        signal: new AbortController().signal,
      });
      const bytes = new Uint8Array(3);
      fixture.filesystem.read(fd, bytes, 0n);
      expect(bytes).toEqual(new Uint8Array([7, 8, 9]));
      expect(fixture.filesystem.fstat(fd).ino).toBe(file);
      expect(fixture.filesystem.lstat("/renamed").ino).toBe(file);
      expect(fixture.filesystem.lstat("/alias").ino).toBe(file);
      expect(fixture.persistence.storage.posix.get(file)).toEqual({ mode: 0o600, uid: 3, gid: 4 });
      expect(fixture.filesystem.readlink("/link")).toBe("renamed");
      expect(() => fixture.filesystem.lstat("/gone")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      expect(fixture.filesystem.fstat(goneFd)).toMatchObject({ ino: gone, nlink: 0n });
      const unlinkedBytes = new Uint8Array(1);
      expect(fixture.filesystem.read(goneFd, unlinkedBytes, 0n)).toBe(1);
      expect(unlinkedBytes).toEqual(goneBytes);
      fixture.filesystem.close(fd);
      fixture.filesystem.close(goneFd);
    } finally {
      fixture.close();
    }
  });

  it("rejects a conflicting apply after a concurrent local write", async () => {
    const original = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      const before = await fixture.workspace.checkpoint(
        "conflict-before",
        new AbortController().signal,
      );
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      const machineFile = fileChange(60n, ["/file"], [], new Uint8Array([9, 9]));
      const result = await commitPort(fixture.ports).commit({
        at: before,
        turnId: "conflict-after",
        changedInodes: [machineFile],
        signal: new AbortController().signal,
      });
      if (result.status === "error") throw new Error(result.error.message);
      const after = { ...before, commit: result.value.commit };
      const epochBeforeWrite = Number(
        [...fixture.storage.sql.exec("SELECT epoch FROM kernel_fs_workspace_state")][0]?.epoch,
      );
      fixture.filesystem.write(fd, new Uint8Array([7, 7]), 0n);
      const epochAfterWrite = Number(
        [...fixture.storage.sql.exec("SELECT epoch FROM kernel_fs_workspace_state")][0]?.epoch,
      );
      expect(epochAfterWrite).toBeGreaterThan(epochBeforeWrite);

      await expect(
        fixture.workspace.apply({
          before,
          after,
          changedInodes: [machineFile],
          hydration: fixture.ports.hydration,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

      const live = new Uint8Array(2);
      fixture.filesystem.read(fd, live, 0n);
      expect(live).toEqual(new Uint8Array([7, 7]));
      expect(fixture.ports.inspectTree(after)?.["/file"]?.data).toEqual(new Uint8Array([9, 9]));
      expect(fixture.filesystem.fstat(fd).ino).toBe(inode);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });
});
