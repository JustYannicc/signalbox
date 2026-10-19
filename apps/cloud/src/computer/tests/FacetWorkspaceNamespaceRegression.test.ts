import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import { createKernelRevisionWorkspace } from "../../kernel/KernelRevisionWorkspace.ts";
import type { CommitInode, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { Inode } from "../../kernel/storage.ts";
import {
  base,
  directoryChange,
  directoryDeletion,
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

function deletedFile(inode: bigint, path: string): CommitInode {
  return {
    inode,
    paths: [],
    removedPaths: [path],
    stat: null,
    symlinkTarget: null,
    posix: null,
    async *readChunks() {},
  };
}

function readFile(fixture: ReturnType<typeof rig>, inode: Inode, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  fixture.persistence.storage.readInto(inode, 0n, bytes);
  return bytes;
}

describe("facet workspace namespace regressions", () => {
  it("rejects paths routed through a nested mount before hydrating or mutating either storage", async () => {
    const primary = rig([]);
    const foreign = rig([]);
    const victim = makeLocalFile(primary.persistence.storage, "/victim", new Uint8Array([22]));
    const foreignFile = makeLocalFile(foreign.persistence.storage, "/file", new Uint8Array([99]));
    const filesystem = new KernelFileSystem({
      mounts: [
        { path: "/", storage: primary.persistence.storage },
        { path: "/nested", storage: foreign.persistence.storage },
      ],
      cwd: "/",
    });
    try {
      const workspace = createKernelRevisionWorkspace({
        database: primary.storage,
        persistence: primary.persistence,
        filesystem,
        mountPath: "/",
        initial: base,
      });
      const changed = fileChange(800n, ["/nested/file"], [], new Uint8Array([0]));
      await expect(
        workspace.apply({
          before: base,
          after: { ...base, commit: "fork-2" },
          changedInodes: [changed],
          hydration: primary.ports.hydration,
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });

      expect(primary.ports.fetchCalls).toHaveLength(0);
      expect(readFile(primary, victim, 1)).toEqual(new Uint8Array([22]));
      expect(readFile(foreign, foreignFile, 1)).toEqual(new Uint8Array([99]));
    } finally {
      filesystem.dispose();
      primary.close();
      foreign.close();
    }
  });

  it("assigns existing inodes before new paths regardless of changed-entry order", async () => {
    for (const replacementFirst of [false, true]) {
      const fixture = rig([{ path: "/old", bytes: new Uint8Array([10]) }]);
      try {
        const original = makeLocalFile(fixture.persistence.storage, "/old", new Uint8Array([10]));
        const before = await fixture.workspace.checkpoint(
          `inode-order-${replacementFirst}`,
          signal(),
        );
        const fd = fixture.filesystem.open("/old", KernelOpenFlags.O_RDONLY);
        const moved = fileChange(801n, ["/moved"], ["/old"], new Uint8Array([11]));
        const replacement = fileChange(802n, ["/old"], [], new Uint8Array([90]));
        const changed = replacementFirst ? [replacement, moved] : [moved, replacement];
        const after = await commit(
          fixture,
          before,
          `inode-order-remote-${replacementFirst}`,
          changed,
        );

        await fixture.workspace.apply({
          before,
          after,
          changedInodes: changed,
          hydration: fixture.ports.hydration,
          signal: signal(),
        });

        const opened = new Uint8Array(1);
        expect(fixture.filesystem.read(fd, opened, 0n)).toBe(1);
        expect(opened).toEqual(new Uint8Array([11]));
        expect(fixture.filesystem.fstat(fd).ino).toBe(original);
        expect(fixture.filesystem.lstat("/moved").ino).toBe(original);
        expect(readFile(fixture, fixture.filesystem.lstat("/old").ino, 1)).toEqual(
          new Uint8Array([90]),
        );
        fixture.filesystem.close(fd);
      } finally {
        fixture.close();
      }
    }
  });

  it("parks a child before moving its parent when the child leaves the renamed tree", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      const original = makeLocalPath(fixture.persistence.storage, "/old/file", new Uint8Array([1]));
      const before = await fixture.workspace.checkpoint("nested-move-before", signal());
      const fd = fixture.filesystem.open("/old/file", KernelOpenFlags.O_RDONLY);
      const directory = directoryChange(803n, "/new", ["/old"]);
      const file = fileChange(804n, ["/away"], ["/old/file"], new Uint8Array([8, 9]));
      const changed = [directory, file];
      const after = await commit(fixture, before, "nested-move-remote", changed);

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: changed,
        hydration: fixture.ports.hydration,
        signal: signal(),
      });

      const opened = new Uint8Array(2);
      expect(fixture.filesystem.read(fd, opened, 0n)).toBe(2);
      expect(opened).toEqual(new Uint8Array([8, 9]));
      expect(fixture.filesystem.fstat(fd).ino).toBe(original);
      expect(fixture.filesystem.lstat("/away").ino).toBe(original);
      expect(fixture.filesystem.lstat("/new").type).toBe("directory");
      expect(() => fixture.filesystem.lstat("/old")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });

  it("removes deleted directories before creating replacements at their old paths", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      makeLocalPath(fixture.persistence.storage, "/a/s/old", new Uint8Array([1]));
      const before = await fixture.workspace.checkpoint("replacement-tree-before", signal());
      const oldA = fixture.filesystem.lstat("/a").ino;
      const oldS = fixture.filesystem.lstat("/a/s").ino;
      const deleted = [
        deletedFile(805n, "/a/s/old"),
        directoryDeletion(806n, "/a/s"),
        directoryDeletion(807n, "/a"),
      ];
      const newA = {
        ...directoryChange(808n, "/a", []),
        stat: { ...directoryChange(808n, "/a", []).stat!, nlink: 3n },
      };
      const newS = directoryChange(809n, "/a/s", []);
      const newFile = fileChange(810n, ["/a/s/new"], [], new Uint8Array([7]));
      const changed = [...deleted, newA, newS, newFile];
      const after = await commit(fixture, before, "replacement-tree-remote", changed);

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: changed,
        hydration: fixture.ports.hydration,
        signal: signal(),
      });

      expect(fixture.filesystem.lstat("/a").ino).not.toBe(oldA);
      expect(fixture.filesystem.lstat("/a/s").ino).not.toBe(oldS);
      expect(readFile(fixture, fixture.filesystem.lstat("/a/s/new").ino, 1)).toEqual(
        new Uint8Array([7]),
      );
      expect(() => fixture.filesystem.lstat("/a/s/old")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      fixture.close();
    }
  });
});
