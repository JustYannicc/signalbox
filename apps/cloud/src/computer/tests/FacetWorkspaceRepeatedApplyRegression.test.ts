import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { CommitInode, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import { directoryChange, fileChange, makeLocalPath, rig } from "./FacetWorkspaceFixture.ts";

const signal = () => new AbortController().signal;

async function commit(
  fixture: ReturnType<typeof rig>,
  at: ForkCommit,
  turnId: string,
  changedInodes: readonly CommitInode[],
): Promise<ForkCommit> {
  const result = await fixture.ports.commits.commit({
    at,
    turnId,
    changedInodes,
    signal: signal(),
  });
  if (result.status === "error") throw new Error(result.error.message);
  return { ...at, commit: result.value.commit };
}

describe("facet workspace retained revision state", () => {
  it("keeps local directory permissions across consecutive remote applies", async () => {
    const fixture = rig([{ path: "/src/seed", bytes: new Uint8Array([1]) }]);
    try {
      makeLocalPath(fixture.persistence.storage, "/src/seed", new Uint8Array([1]));
      const inode = fixture.filesystem.lstat("/src").ino;
      fixture.persistence.storage.posix.initialize(inode, { mode: 0o755, uid: 1000, gid: 1000 });
      const before = await fixture.workspace.checkpoint("repeated-before", signal());
      fixture.persistence.storage.posix.chmod(inode, 0o700);
      const first = {
        ...directoryChange(900n, "/src", []),
        posix: { mode: 0o755, uid: 2000, gid: 1000 },
      };
      const afterFirst = await commit(fixture, before, "repeated-first", [first]);
      await fixture.workspace.apply({
        before,
        after: afterFirst,
        changedInodes: [first],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      expect(fixture.persistence.storage.posix.get(inode)).toEqual({
        mode: 0o700,
        uid: 2000,
        gid: 1000,
      });
      const second = { ...first, posix: { mode: 0o755, uid: 2000, gid: 3000 } };
      const afterSecond = await commit(fixture, afterFirst, "repeated-second", [second]);
      await fixture.workspace.apply({
        before: afterFirst,
        after: afterSecond,
        changedInodes: [second],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      const expected = { mode: 0o700, uid: 2000, gid: 3000 };
      expect(fixture.persistence.storage.posix.get(inode)).toEqual(expected);
      expect(fixture.ports.inspectTree(afterSecond)?.["/src"]?.posix?.mode).toBe(0o755);
      const next = await fixture.workspace.checkpoint("repeated-local", signal());
      expect(fixture.ports.inspectTree(next)?.["/src"]?.posix).toEqual(expected);
    } finally {
      fixture.close();
    }
  });

  it("removes parked hardlink aliases when a parent move restores the primary path", async () => {
    const fixture = rig([{ path: "/a/x", bytes: new Uint8Array([1]) }]);
    try {
      const inode = makeLocalPath(fixture.persistence.storage, "/a/x", new Uint8Array([1]));
      fixture.filesystem.link("/a/x", "/z");
      const fd = fixture.filesystem.open("/a/x", KernelOpenFlags.O_RDONLY);
      const before = await fixture.workspace.checkpoint("hardlink-before", signal());
      const changes = [
        directoryChange(901n, "/b", ["/a"]),
        fileChange(902n, ["/b/x", "/z"], ["/a/x"], new Uint8Array([9])),
      ];
      const after = await commit(fixture, before, "hardlink-remote", changes);
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: changes,
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      expect(fixture.filesystem.readdir("/").sort()).toEqual(["b", "z"]);
      expect(fixture.filesystem.lstat("/b/x").ino).toBe(inode);
      expect(fixture.filesystem.lstat("/z").ino).toBe(inode);
      expect(fixture.filesystem.fstat(fd).nlink).toBe(2n);
      const actual = new Uint8Array(1);
      expect(fixture.filesystem.read(fd, actual, 0n)).toBe(1);
      expect(actual).toEqual(new Uint8Array([9]));
      const next = await fixture.workspace.checkpoint("hardlink-next", signal());
      expect(Object.keys(fixture.ports.inspectTree(next)!).sort()).toEqual(["/b", "/b/x", "/z"]);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });
});
