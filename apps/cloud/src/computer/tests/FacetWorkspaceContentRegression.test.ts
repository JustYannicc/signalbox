import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { fileChange, makeLocalFile, rig } from "./FacetWorkspaceFixture.ts";

const signal = () => new AbortController().signal;

describe("facet workspace file content identity", () => {
  it.each([
    { name: "applies remote bytes when the local file is unchanged", localWrite: false },
    { name: "retains both versions when the local file is dirty", localWrite: true },
  ])("$name even when all file stats match", async ({ localWrite }) => {
    const original = new Uint8Array([1, 2]);
    const remoteBytes = new Uint8Array([8, 9]);
    const localBytes = new Uint8Array([4, 5]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      const before = await fixture.workspace.checkpoint("content-before", signal());
      const baselineStat = fixture.persistence.storage.stat(inode);
      const remote = {
        ...fileChange(800n, ["/file"], [], remoteBytes, {
          mode: 0o644,
          uid: 1000,
          gid: 1000,
        }),
        stat: baselineStat,
      };
      const committed = await fixture.ports.commits.commit({
        at: before,
        turnId: "content-remote",
        changedInodes: [remote],
        signal: signal(),
      });
      if (committed.status === "error") throw new Error(committed.error.message);
      const after = { ...before, commit: committed.value.commit };
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      if (localWrite) {
        fixture.filesystem.write(fd, localBytes, 0n);
        fixture.persistence.storage.setTimes(inode, {
          atimeNs: baselineStat.atimeNs,
          mtimeNs: baselineStat.mtimeNs,
        });
      }
      const applying = fixture.workspace.apply({
        before,
        after,
        changedInodes: [remote],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      if (localWrite) {
        await expect(applying).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });
      } else {
        await applying;
      }
      const actual = new Uint8Array(2);
      fixture.persistence.storage.readInto(inode, 0n, actual);
      expect(actual).toEqual(localWrite ? localBytes : remoteBytes);
      expect(fixture.filesystem.lstat("/file").ino).toBe(inode);
      expect(fixture.ports.inspectTree(after)?.["/file"]?.data).toEqual(remoteBytes);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });
});
