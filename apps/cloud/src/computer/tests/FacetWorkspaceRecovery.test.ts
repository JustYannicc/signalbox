import { describe, expect, it } from "vite-plus/test";
import { KernelOpenFlags } from "../../kernel/KernelFileSystem.ts";
import type { FileHydrationPort } from "../../kernel/FilePersistencePorts.ts";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
import type { MachineWorkspaceMount } from "../MachineWorkspace.ts";
import { base, commitPort, fileChange, makeLocalFile, rig } from "./FacetWorkspaceFixture.ts";

describe("facet workspace recovery", () => {
  it("replays a durable checkpoint receipt after recreating the workspace", async () => {
    const fixture = rig([{ path: "/file", bytes: new Uint8Array([1]) }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", new Uint8Array([1]));
      const [first, concurrent] = await Promise.all([
        fixture.workspace.checkpoint("stable-checkpoint", new AbortController().signal),
        fixture.workspace.checkpoint("stable-checkpoint", new AbortController().signal),
      ]);
      expect(concurrent).toEqual(first);
      expect(fixture.ports.committedTurns).toHaveLength(1);
      const reopened = createFacetWorkspace({
        database: fixture.storage,
        persistence: fixture.persistence,
        filesystem: fixture.filesystem,
        mountPath: "/",
        initial: base,
        mount: async () => {
          throw new Error("The external machine mount is outside this adapter test");
        },
      });
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      fixture.filesystem.write(fd, new Uint8Array([2]), 0n);

      const replay = await reopened.checkpoint("stable-checkpoint", new AbortController().signal);
      expect(replay).toEqual(first);
      expect(fixture.ports.committedTurns).toHaveLength(1);
      const next = await reopened.checkpoint("next-checkpoint", new AbortController().signal);
      expect(next.commit).not.toBe(first.commit);
      expect(fixture.ports.inspectTree(next)?.["/file"]?.data).toEqual(new Uint8Array([2]));
      expect(fixture.filesystem.lstat("/file").ino).toBe(inode);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });

  it("does not resume an uncommitted checkpoint over writes made after its attempt", async () => {
    const original = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    const commitTurn = fixture.persistence.commitTurn;
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      fixture.persistence.commitTurn = async () => {
        throw new Error("simulated interruption before persistence captured the snapshot");
      };
      await expect(
        fixture.workspace.checkpoint("interrupted-checkpoint", new AbortController().signal),
      ).rejects.toThrow("simulated interruption");

      fixture.persistence.commitTurn = commitTurn;
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      fixture.filesystem.write(fd, new Uint8Array([7, 8]), 0n);
      const reopened = createFacetWorkspace({
        database: fixture.storage,
        persistence: fixture.persistence,
        filesystem: fixture.filesystem,
        mountPath: "/",
        initial: base,
        mount: async () => {
          throw new Error("The external machine mount is outside this adapter test");
        },
      });

      await expect(
        reopened.checkpoint("interrupted-checkpoint", new AbortController().signal),
      ).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });
      expect(fixture.ports.committedTurns).toHaveLength(0);
      expect(fixture.filesystem.lstat("/file").ino).toBe(inode);
      const live = new Uint8Array(2);
      fixture.filesystem.read(fd, live, 0n);
      expect(live).toEqual(new Uint8Array([7, 8]));
      fixture.filesystem.close(fd);
    } finally {
      fixture.persistence.commitTurn = commitTurn;
      fixture.close();
    }
  });

  it("resumes only the exact machine operation and before revision supplied by its owner", async () => {
    const mount: MachineWorkspaceMount = {
      canonicalCwd: async () => "/",
      changes: async () => [],
    };
    const machine = { id: "machine-1", generation: 4, release: async () => {} };
    const fixture = rig([], async ({ operationId, machine: requested, before }) => ({
      mount,
      ownership: {
        operationId,
        machineId: requested.id,
        generation: requested.generation,
        before,
      },
    }));
    try {
      const resumed = await fixture.workspace.resume?.({
        operationId: "operation-1",
        machine,
        before: base,
        signal: new AbortController().signal,
      });
      expect(resumed?.mount).toBe(mount);
      expect(resumed?.ownership).toEqual({
        operationId: "operation-1",
        machineId: "machine-1",
        generation: 4,
        before: base,
      });
      expect(Object.isFrozen(resumed?.ownership)).toBe(true);

      const mismatched = rig([], async ({ operationId, machine: requested }) => ({
        mount,
        ownership: {
          operationId,
          machineId: requested.id,
          generation: requested.generation,
          before: { ...base, commit: "other-revision" },
        },
      }));
      try {
        await expect(
          mismatched.workspace.resume?.({
            operationId: "operation-1",
            machine,
            before: base,
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: "ESTALE" });
      } finally {
        mismatched.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("detects a local write while machine files are hydrating and leaves it untouched", async () => {
    const original = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      const before = await fixture.workspace.checkpoint(
        "hydration-race-before",
        new AbortController().signal,
      );
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      const machineFile = fileChange(61n, ["/file"], [], new Uint8Array([9, 9]));
      const result = await commitPort(fixture.ports).commit({
        at: before,
        turnId: "hydration-race-after",
        changedInodes: [machineFile],
        signal: new AbortController().signal,
      });
      if (result.status === "error") throw new Error(result.error.message);
      const after = { ...before, commit: result.value.commit };

      let started!: () => void;
      let release!: () => void;
      const fetchStarted = new Promise<void>((resolve) => (started = resolve));
      const hydrationGate = new Promise<void>((resolve) => (release = resolve));
      const delayedHydration: FileHydrationPort = {
        async fetch(input) {
          started();
          await hydrationGate;
          return fixture.ports.hydration.fetch(input);
        },
      };
      const applying = fixture.workspace.apply({
        before,
        after,
        changedInodes: [machineFile],
        hydration: delayedHydration,
        signal: new AbortController().signal,
      });
      await fetchStarted;
      fixture.filesystem.write(fd, new Uint8Array([7, 7]), 0n);
      release();
      await expect(applying).rejects.toMatchObject({ code: "LIVE_FILESYSTEM_DIVERGED" });

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

  it("rolls back a failed apply and lets the same immutable revision retry", async () => {
    const original = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/file", bytes: original }]);
    try {
      const inode = makeLocalFile(fixture.persistence.storage, "/file", original);
      const before = await fixture.workspace.checkpoint(
        "atomic-apply-before",
        new AbortController().signal,
      );
      const fd = fixture.filesystem.open("/file", KernelOpenFlags.O_RDWR);
      const machineFile = fileChange(62n, ["/renamed"], ["/file"], new Uint8Array([8, 9]));
      const result = await commitPort(fixture.ports).commit({
        at: before,
        turnId: "atomic-apply-after",
        changedInodes: [machineFile],
        signal: new AbortController().signal,
      });
      if (result.status === "error") throw new Error(result.error.message);
      const after = { ...before, commit: result.value.commit };
      fixture.storage.sql.exec(
        `CREATE TRIGGER fail_workspace_apply BEFORE UPDATE ON kernel_fs_posix WHEN OLD.ino = '${inode}' BEGIN SELECT RAISE(ABORT, 'injected apply failure'); END`,
      );

      await expect(
        fixture.workspace.apply({
          before,
          after,
          changedInodes: [machineFile],
          hydration: fixture.ports.hydration,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(
        [...fixture.storage.sql.exec("SELECT commit_id FROM kernel_fs_workspace_state")][0]
          ?.commit_id,
      ).toBe(before.commit);
      expect(fixture.filesystem.lstat("/file").ino).toBe(inode);
      expect(() => fixture.filesystem.lstat("/renamed")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      const afterFailure = new Uint8Array(2);
      fixture.filesystem.read(fd, afterFailure, 0n);
      expect(afterFailure).toEqual(original);

      fixture.storage.sql.exec("DROP TRIGGER fail_workspace_apply");
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [machineFile],
        hydration: fixture.ports.hydration,
        signal: new AbortController().signal,
      });
      const afterRetry = new Uint8Array(2);
      fixture.filesystem.read(fd, afterRetry, 0n);
      expect(afterRetry).toEqual(new Uint8Array([8, 9]));
      expect(fixture.filesystem.fstat(fd).ino).toBe(inode);
      expect(fixture.filesystem.lstat("/renamed").ino).toBe(inode);
      fixture.filesystem.close(fd);
    } finally {
      fixture.close();
    }
  });
});
