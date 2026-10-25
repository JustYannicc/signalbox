import { describe, expect, it } from "vite-plus/test";
import type { CommitInode, ForkCommit } from "../../kernel/FilePersistencePorts.ts";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import {
  commitPort,
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
  const result = await commitPort(fixture.ports).commit({
    at,
    turnId,
    changedInodes,
    signal: signal(),
  });
  if (result.status === "error") throw new Error(result.error.message);
  return { ...at, commit: result.value.commit };
}

async function apply(
  fixture: ReturnType<typeof rig>,
  before: ForkCommit,
  changedInodes: readonly CommitInode[],
  turnId: string,
): Promise<ForkCommit> {
  const after = await commit(fixture, before, turnId, changedInodes);
  await fixture.workspace.apply({
    before,
    after,
    changedInodes,
    hydration: fixture.ports.hydration,
    signal: signal(),
  });
  return after;
}

describe("kernel revision conflicts for disjoint directory changes", () => {
  it("merges a top-level VM creation with a local creation and checkpoints both", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array([0]) }]);
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array([0]));
      const before = await fixture.workspace.checkpoint("root-create-before", signal());
      const localInode = makeLocalFile(fixture.persistence.storage, "/local", new Uint8Array([1]));
      const remote = fileChange(220n, ["/remote"], [], new Uint8Array([2]));

      const after = await apply(fixture, before, [remote], "root-create-after");
      expect(fixture.filesystem.lstat("/local").ino).toBe(localInode);
      expect(fixture.ports.inspectTree(after)?.["/remote"]?.data).toEqual(new Uint8Array([2]));

      const next = await fixture.workspace.checkpoint("root-create-local-checkpoint", signal());
      expect(fixture.ports.inspectTree(next)?.["/local"]?.data).toEqual(new Uint8Array([1]));
      expect(fixture.ports.inspectTree(next)?.["/remote"]?.data).toEqual(new Uint8Array([2]));
    } finally {
      fixture.close();
    }
  });

  it("merges sibling creates under a directory whose timestamp also changed", async () => {
    const fixture = rig([{ path: "/src/base", bytes: new Uint8Array([0]) }]);
    try {
      makeLocalPath(fixture.persistence.storage, "/src/base", new Uint8Array([0]));
      const before = await fixture.workspace.checkpoint("nested-create-before", signal());
      const localInode = makeLocalPath(
        fixture.persistence.storage,
        "/src/new",
        new Uint8Array([1]),
      );
      const remote = fileChange(221n, ["/src/gen"], [], new Uint8Array([2]));
      const parent = directoryChange(222n, "/src", []);

      const after = await apply(fixture, before, [remote, parent], "nested-create-after");
      expect(fixture.filesystem.lstat("/src/new").ino).toBe(localInode);
      expect(fixture.ports.inspectTree(after)?.["/src/gen"]?.data).toEqual(new Uint8Array([2]));

      const next = await fixture.workspace.checkpoint("nested-create-local-checkpoint", signal());
      expect(fixture.ports.inspectTree(next)?.["/src/new"]?.data).toEqual(new Uint8Array([1]));
      expect(fixture.ports.inspectTree(next)?.["/src/gen"]?.data).toEqual(new Uint8Array([2]));
    } finally {
      fixture.close();
    }
  });

  it("merges a local file edit with a VM sibling create and parent timestamp", async () => {
    const original = new Uint8Array([0, 0]);
    const localBytes = new Uint8Array([7, 8]);
    const fixture = rig([{ path: "/src/a.ts", bytes: original }]);
    try {
      const localInode = makeLocalPath(fixture.persistence.storage, "/src/a.ts", original);
      const before = await fixture.workspace.checkpoint("content-edit-before", signal());
      const fd = fixture.filesystem.open("/src/a.ts", KernelOpenFlags.O_RDWR);
      fixture.filesystem.write(fd, localBytes, 0n);
      const remote = fileChange(223n, ["/src/b"], [], new Uint8Array([3]));
      const parent = directoryChange(224n, "/src", []);

      const after = await apply(fixture, before, [parent, remote], "content-edit-after");
      const local = new Uint8Array(2);
      fixture.persistence.storage.readInto(localInode, 0n, local);
      expect(local).toEqual(localBytes);
      expect(fixture.ports.inspectTree(after)?.["/src/b"]?.data).toEqual(new Uint8Array([3]));

      const next = await fixture.workspace.checkpoint("content-edit-local-checkpoint", signal());
      expect(fixture.ports.inspectTree(next)?.["/src/a.ts"]?.data).toEqual(localBytes);
      expect(fixture.ports.inspectTree(next)?.["/src/b"]?.data).toEqual(new Uint8Array([3]));
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });

  it("rejects VM directory moves and deletions that contain a local child edit", async () => {
    for (const move of [false, true]) {
      const original = new Uint8Array([0]);
      const fixture = rig([{ path: "/src/a.ts", bytes: original }]);
      try {
        const inode = makeLocalPath(fixture.persistence.storage, "/src/a.ts", original);
        const before = await fixture.workspace.checkpoint(`remote-dir-before-${move}`, signal());
        const fd = fixture.filesystem.open("/src/a.ts", KernelOpenFlags.O_RDWR);
        fixture.filesystem.write(fd, new Uint8Array([9]), 0n);
        const remote = move
          ? directoryChange(225n, "/moved", ["/src"])
          : directoryDeletion(226n, "/src");
        const after = await commit(fixture, before, `remote-dir-after-${move}`, [remote]);

        await expect(
          fixture.workspace.apply({
            before,
            after,
            changedInodes: [remote],
            hydration: fixture.ports.hydration,
            signal: signal(),
          }),
        ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

        expect(fixture.filesystem.lstat("/src/a.ts").ino).toBe(inode);
        const local = new Uint8Array(1);
        fixture.persistence.storage.readInto(inode, 0n, local);
        expect(local).toEqual(new Uint8Array([9]));
        fixture.filesystem.close(fd);
      } finally {
        fixture.close();
      }
    }
  });

  it("rejects VM child creation inside a locally moved or deleted directory", async () => {
    for (const move of [false, true]) {
      const fixture = rig([{ path: "/seed", bytes: new Uint8Array([0]) }]);
      try {
        makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array([0]));
        fixture.filesystem.mkdir("/src");
        const before = await fixture.workspace.checkpoint(`local-dir-before-${move}`, signal());
        if (move) fixture.filesystem.rename("/src", "/moved");
        else fixture.filesystem.rmdir("/src");
        const remote = fileChange(227n, ["/src/gen"], [], new Uint8Array([2]));
        const after = await commit(fixture, before, `local-dir-after-${move}`, [remote]);

        await expect(
          fixture.workspace.apply({
            before,
            after,
            changedInodes: [remote],
            hydration: fixture.ports.hydration,
            signal: signal(),
          }),
        ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

        expect(fixture.ports.inspectTree(after)?.["/src/gen"]?.data).toEqual(new Uint8Array([2]));
      } finally {
        fixture.close();
      }
    }
  });
});
