import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem, KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type {
  CommitInode,
  FileHydrationPort,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
import {
  base,
  commitPort,
  directoryDeletion,
  fileChange,
  makeLocalFile,
  rig,
} from "./FacetWorkspaceFixture.ts";

const signal = () => new AbortController().signal;

async function commit(
  fixture: ReturnType<typeof rig>,
  at: ForkCommit,
  turnId: string,
  changedInodes: readonly CommitInode[],
): Promise<ForkCommit> {
  const result = await commitPort(fixture.ports).commit({
    at,
    turnId,
    changedInodes,
    signal: signal(),
  });
  if (result.status === "error") throw new Error(result.error.message);
  return { ...at, commit: result.value.commit };
}

function readFile(fixture: ReturnType<typeof rig>, inode: bigint, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  fixture.persistence.storage.readInto(inode, 0n, bytes);
  return bytes;
}

describe("kernel revision apply merge and namespace recovery", () => {
  it("merges a disjoint write during hydration and checkpoints the local change next", async () => {
    const localBytes = new Uint8Array([1, 2]);
    const remoteBytes = new Uint8Array([3, 4]);
    const fixture = rig([
      { path: "/local", bytes: localBytes },
      { path: "/remote", bytes: remoteBytes },
    ]);
    let release!: () => void;
    try {
      const localInode = makeLocalFile(fixture.persistence.storage, "/local", localBytes);
      makeLocalFile(fixture.persistence.storage, "/remote", remoteBytes);
      const before = await fixture.workspace.checkpoint("disjoint-before", signal());
      const fd = fixture.filesystem.open("/local", KernelOpenFlags.O_RDWR);
      const localChange = new Uint8Array([7, 8]);
      const remoteChange = fileChange(202n, ["/remote"], [], new Uint8Array([9, 10]));
      const after = await commit(fixture, before, "disjoint-after", [remoteChange]);
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
        changedInodes: [remoteChange],
        hydration,
        signal: signal(),
      });
      await fetchStarted;
      fixture.filesystem.write(fd, localChange, 0n);
      release();
      await applying;

      expect(fixture.filesystem.lstat("/local").ino).toBe(localInode);
      expect(readFile(fixture, localInode, 2)).toEqual(localChange);
      expect(fixture.ports.inspectTree(after)?.["/remote"]?.data).toEqual(new Uint8Array([9, 10]));

      const next = await fixture.workspace.checkpoint("disjoint-local-checkpoint", signal());
      expect(fixture.ports.inspectTree(next)?.["/local"]?.data).toEqual(localChange);
      expect(fixture.ports.inspectTree(next)?.["/remote"]?.data).toEqual(new Uint8Array([9, 10]));
      fixture.filesystem.close(fd);
    } finally {
      release?.();
      fixture.close();
    }
  });

  it("keeps an overlapping truncation and the committed VM revision available", async () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      const before = await fixture.workspace.checkpoint("truncate-before", signal());
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      const remoteChange = fileChange(203n, ["/file"], [], new Uint8Array([9, 8, 7]));
      const after = await commit(fixture, before, "truncate-after", [remoteChange]);
      fixture.filesystem.ftruncate(fd, 1n);

      await expect(
        fixture.workspace.apply({
          before,
          after,
          changedInodes: [remoteChange],
          hydration: fixture.ports.hydration,
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

      expect(readFile(fixture, inode, 1)).toEqual(new Uint8Array([1]));
      expect(fixture.ports.inspectTree(after)?.["/file"]?.data).toEqual(new Uint8Array([9, 8, 7]));
      expect(
        [...fixture.storage.sql.exec("SELECT commit_id FROM kernel_fs_workspace_state")][0]
          ?.commit_id,
      ).toBe(before.commit);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });

  it("rejects changed paths through a foreign descendant mount before either store changes", async () => {
    const victimBytes = new Uint8Array([22]);
    const primary = rig([{ path: "/victim", bytes: victimBytes }]);
    const foreign = rig([]);
    const victim = makeLocalFile(primary.persistence.storage, "/victim", victimBytes);
    const foreignFile = makeLocalFile(foreign.persistence.storage, "/file", new Uint8Array([33]));
    expect(victim).toBe(foreignFile);
    const filesystem = new KernelFileSystem({
      mounts: [
        { path: "/", storage: primary.persistence.storage },
        { path: "/nested", storage: foreign.persistence.storage },
      ],
      cwd: "/",
    });
    const workspace = createFacetWorkspace({
      database: primary.storage,
      persistence: primary.persistence,
      filesystem,
      mountPath: "/",
      initial: base,
      mount: async () => {
        throw new Error("The external machine mount is outside this adapter test");
      },
    });
    try {
      const before = await workspace.checkpoint("foreign-mount-before", signal());
      expect(filesystem.resolve("/nested/file", { followFinal: false }).mount.storage).toBe(
        foreign.persistence.storage,
      );
      const changed = fileChange(204n, ["/nested/file"], [], new Uint8Array([99]));
      const after = await commit(primary, before, "foreign-mount-after", [changed]);

      await expect(
        workspace.apply({
          before,
          after,
          changedInodes: [changed],
          hydration: primary.ports.hydration,
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });

      expect(readFile(primary, victim, 1)).toEqual(new Uint8Array([22]));
      expect(readFile(foreign, foreignFile, 1)).toEqual(new Uint8Array([33]));
      expect(primary.ports.fetchCalls).toHaveLength(0);
      expect(
        [...primary.storage.sql.exec("SELECT commit_id FROM kernel_fs_workspace_state")][0]
          ?.commit_id,
      ).toBe(before.commit);
    } finally {
      filesystem.dispose();
      primary.close();
      foreign.close();
    }
  });

  it("does not remove a replacement path when finishing a deferred directory delete", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      fixture.filesystem.mkdir("/item");
      const before = await fixture.workspace.checkpoint("directory-replacement-before", signal());
      const deletion = directoryDeletion(205n, "/item");
      const replacement = fileChange(206n, ["/item"], [], new Uint8Array([9, 9]));
      const after = await commit(fixture, before, "directory-replacement-after", [
        deletion,
        replacement,
      ]);

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [deletion, replacement],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });

      const inode = fixture.filesystem.lstat("/item").ino;
      expect(fixture.filesystem.lstat("/item").type).toBe("file");
      expect(readFile(fixture, inode, 2)).toEqual(new Uint8Array([9, 9]));
      expect(fixture.ports.inspectTree(after)?.["/item"]?.data).toEqual(new Uint8Array([9, 9]));
    } finally {
      fixture.close();
    }
  });

  it("keeps a renamed inode ahead of a replacement at its old path regardless of plan order", async () => {
    for (const reverse of [false, true]) {
      const fixture = rig([{ path: "/old", bytes: new Uint8Array([10]) }]);
      try {
        const inode = makeLocalFile(fixture.persistence.storage, "/old", new Uint8Array([10]));
        const before = await fixture.workspace.checkpoint(
          `rename-order-before-${reverse}`,
          signal(),
        );
        const fd = fixture.filesystem.open("/old", KernelOpenFlags.O_RDONLY);
        const replacement = fileChange(207n, ["/old"], [], new Uint8Array([90]));
        const renamed = fileChange(208n, ["/moved"], ["/old"], new Uint8Array([20]));
        const changed = reverse ? [renamed, replacement] : [replacement, renamed];
        const after = await commit(fixture, before, `rename-order-after-${reverse}`, changed);

        await fixture.workspace.apply({
          before,
          after,
          changedInodes: changed,
          hydration: fixture.ports.hydration,
          signal: signal(),
        });

        expect(fixture.filesystem.lstat("/moved").ino).toBe(inode);
        expect(fixture.filesystem.lstat("/old").ino).not.toBe(inode);
        expect(readFile(fixture, inode, 1)).toEqual(new Uint8Array([20]));
        expect(fixture.ports.inspectTree(after)?.["/old"]?.data).toEqual(new Uint8Array([90]));
        expect(fixture.ports.inspectTree(after)?.["/moved"]?.data).toEqual(new Uint8Array([20]));
        const descriptorBytes = new Uint8Array(1);
        fixture.filesystem.read(fd, descriptorBytes, 0n);
        expect(descriptorBytes).toEqual(new Uint8Array([20]));
        fixture.filesystem.close(fd);
      } finally {
        fixture.close();
      }
    }
  });
});
