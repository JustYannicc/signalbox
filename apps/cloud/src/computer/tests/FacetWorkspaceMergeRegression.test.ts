import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type {
  CommitInode,
  FileHydrationPort,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import {
  directoryChange,
  fileChange,
  makeLocalFile,
  makeLocalPath,
  rig,
} from "./FacetWorkspaceFixture.ts";

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

describe("facet workspace merge regressions", () => {
  it("applies a disjoint VM write and keeps the local write for the next checkpoint", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    const localBytes = new Uint8Array([4, 5, 6]);
    let release = () => {};
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      const before = await fixture.workspace.checkpoint("merge-before", signal());
      const remote = fileChange(700n, ["/remote"], [], new Uint8Array([7, 8]));
      const after = await commit(fixture, before, "merge-remote", [remote]);
      let started!: () => void;
      const fetchStarted = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const hydration: FileHydrationPort = {
        async fetch(input) {
          started();
          await gate;
          return fixture.ports.hydration.fetch(input);
        },
      };

      const applying = fixture.workspace.apply({
        before,
        after,
        changedInodes: [remote],
        hydration,
        signal: signal(),
      });
      await fetchStarted;
      const localInode = makeLocalFile(fixture.persistence.storage, "/local", localBytes);
      release();
      await applying;

      expect(fixture.filesystem.lstat("/remote").ino).not.toBe(localInode);
      expect(fixture.filesystem.lstat("/local").ino).toBe(localInode);
      const local = new Uint8Array(localBytes.length);
      fixture.persistence.storage.readInto(localInode, 0n, local);
      expect(local).toEqual(localBytes);

      await fixture.workspace.checkpoint("merge-local-checkpoint", signal());
      const committed = fixture.ports.committedTurns.at(-1)?.tree;
      expect(committed?.["/local"]?.data).toEqual(localBytes);
      expect(committed?.["/remote"]?.data).toEqual(new Uint8Array([7, 8]));
    } finally {
      release();
      fixture.close();
    }
  });

  it("keeps an overlapping local create intact and lets the same apply retry after resolution", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    const localBytes = new Uint8Array([3]);
    const remoteBytes = new Uint8Array([9]);
    let release = () => {};
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      const before = await fixture.workspace.checkpoint("overlap-before", signal());
      const remote = fileChange(701n, ["/same"], [], remoteBytes);
      const after = await commit(fixture, before, "overlap-remote", [remote]);
      let started!: () => void;
      const fetchStarted = new Promise<void>((resolve) => (started = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const hydration: FileHydrationPort = {
        async fetch(input) {
          started();
          await gate;
          return fixture.ports.hydration.fetch(input);
        },
      };
      const applying = fixture.workspace.apply({
        before,
        after,
        changedInodes: [remote],
        hydration,
        signal: signal(),
      });
      await fetchStarted;
      const localInode = makeLocalFile(fixture.persistence.storage, "/same", localBytes);
      release();
      await expect(applying).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

      const preserved = new Uint8Array(1);
      fixture.persistence.storage.readInto(localInode, 0n, preserved);
      expect(preserved).toEqual(localBytes);
      expect(fixture.filesystem.lstat("/same").ino).toBe(localInode);

      fixture.filesystem.unlink("/same");
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [remote],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      const applied = new Uint8Array(1);
      const remoteInode = fixture.filesystem.lstat("/same").ino;
      fixture.persistence.storage.readInto(remoteInode, 0n, applied);
      expect(applied).toEqual(remoteBytes);
    } finally {
      release();
      fixture.close();
    }
  });

  it("merges directory permissions and derives link counts from the merged live tree", async () => {
    const fixture = rig([{ path: "/src/seed", bytes: new Uint8Array() }]);
    try {
      const source = makeLocalPath(fixture.persistence.storage, "/src/seed", new Uint8Array());
      const directory = fixture.filesystem.resolve("/src", { followFinal: false }).inode;
      fixture.persistence.storage.posix.initialize(directory, {
        mode: 0o755,
        uid: 1000,
        gid: 1000,
      });
      const before = await fixture.workspace.checkpoint("directory-merge-before", signal());

      fixture.filesystem.mkdir("/src/local-a");
      fixture.filesystem.mkdir("/src/local-b");
      fixture.persistence.storage.posix.chmod(directory, 0o700);
      const remoteSource: CommitInode = {
        ...directoryChange(702n, "/src", []),
        stat: { ...directoryChange(702n, "/src", []).stat!, nlink: 3n },
        posix: { mode: 0o755, uid: 1000, gid: 1000 },
      };
      const remoteDirectory = directoryChange(703n, "/src/vm", []);
      const after = await commit(fixture, before, "directory-merge-remote", [
        remoteSource,
        remoteDirectory,
      ]);
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [remoteSource, remoteDirectory],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });

      expect(fixture.persistence.storage.posix.get(directory).mode).toBe(0o700);
      expect(fixture.persistence.storage.stat(directory).nlink).toBe(5n);
      expect(fixture.filesystem.lstat("/src/local-a").type).toBe("directory");
      expect(fixture.filesystem.lstat("/src/local-b").type).toBe("directory");
      expect(fixture.filesystem.lstat("/src/vm").type).toBe("directory");

      await fixture.workspace.checkpoint("directory-merge-local-checkpoint", signal());
      const committed = fixture.ports.committedTurns.at(-1)?.tree;
      expect(committed?.["/src/local-a"]?.stat.type).toBe("directory");
      expect(committed?.["/src/local-b"]?.stat.type).toBe("directory");
      expect(committed?.["/src"]?.stat.nlink).toBe(5n);
      expect(committed?.["/src"]?.posix).toEqual({ mode: 0o700, uid: 1000, gid: 1000 });
      expect(fixture.filesystem.lstat("/src/seed").ino).toBe(source);
    } finally {
      fixture.close();
    }
  });

  it("merges local and VM POSIX changes by field", async () => {
    const fixture = rig([{ path: "/src/seed", bytes: new Uint8Array() }]);
    try {
      makeLocalPath(fixture.persistence.storage, "/src/seed", new Uint8Array());
      const directory = fixture.filesystem.resolve("/src", { followFinal: false }).inode;
      fixture.persistence.storage.posix.initialize(directory, {
        mode: 0o755,
        uid: 1000,
        gid: 1000,
      });
      const before = await fixture.workspace.checkpoint("posix-field-merge-before", signal());
      fixture.persistence.storage.posix.chmod(directory, 0o700);

      const remote = {
        ...directoryChange(704n, "/src", []),
        posix: { mode: 0o755, uid: 2000, gid: 1000 },
      } satisfies CommitInode;
      const after = await commit(fixture, before, "posix-field-merge-remote", [remote]);
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [remote],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });

      expect(fixture.persistence.storage.posix.get(directory)).toEqual({
        mode: 0o700,
        uid: 2000,
        gid: 1000,
      });
    } finally {
      fixture.close();
    }
  });

  it("retains a conflict for a local file write and a VM POSIX-only file plan", async () => {
    const original = new Uint8Array([1, 2]);
    const localBytes = new Uint8Array([7, 8]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      const before = await fixture.workspace.checkpoint("file-posix-merge-before", signal());
      const baselineStat = fixture.persistence.storage.stat(inode);
      const remote = {
        ...fileChange(705n, ["/file"], [], original, {
          mode: 0o600,
          uid: 1000,
          gid: 1000,
        }),
        stat: baselineStat,
      } satisfies CommitInode;
      const after = await commit(fixture, before, "file-posix-merge-remote", [remote]);
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      fixture.filesystem.write(fd, localBytes, 0n);
      fixture.persistence.storage.setTimes(inode, { mtimeNs: baselineStat.mtimeNs + 1n });

      await expect(
        fixture.workspace.apply({
          before,
          after,
          changedInodes: [remote],
          hydration: fixture.ports.hydration,
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

      const actual = new Uint8Array(localBytes.length);
      fixture.persistence.storage.readInto(inode, 0n, actual);
      expect(actual).toEqual(localBytes);
      expect(fixture.persistence.storage.posix.get(inode).mode).toBe(0o644);
      expect(fixture.ports.inspectTree(after)?.["/file"]?.data).toEqual(original);
      expect(fixture.ports.inspectTree(after)?.["/file"]?.posix?.mode).toBe(0o600);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });

  it("rejects divergent changes to the same POSIX field before hydration", async () => {
    const fixture = rig([{ path: "/src/seed", bytes: new Uint8Array() }]);
    try {
      makeLocalPath(fixture.persistence.storage, "/src/seed", new Uint8Array());
      const directory = fixture.filesystem.resolve("/src", { followFinal: false }).inode;
      fixture.persistence.storage.posix.initialize(directory, {
        mode: 0o755,
        uid: 1000,
        gid: 1000,
      });
      const before = await fixture.workspace.checkpoint("posix-conflict-before", signal());
      fixture.persistence.storage.posix.chmod(directory, 0o700);
      const remote = {
        ...directoryChange(706n, "/src", []),
        posix: { mode: 0o600, uid: 1000, gid: 1000 },
      } satisfies CommitInode;
      const remoteFile = fileChange(707n, ["/src/vm"], [], new Uint8Array([1]));
      const changed = [remote, remoteFile];
      const after = await commit(fixture, before, "posix-conflict-remote", changed);

      await expect(
        fixture.workspace.apply({
          before,
          after,
          changedInodes: changed,
          hydration: fixture.ports.hydration,
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });
      expect(fixture.persistence.storage.posix.get(directory).mode).toBe(0o700);
      expect(fixture.ports.fetchCalls).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
});
