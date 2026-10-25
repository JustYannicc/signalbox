import { describe, expect, it } from "vite-plus/test";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type {
  CommitInode,
  FileHydrationPort,
  ForkCommit,
} from "../../kernel/FilePersistencePorts.ts";
import { createFacetWorkspace } from "../FacetWorkspace.ts";
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

function readFile(
  storage: ReturnType<typeof rig>["persistence"]["storage"],
  inode: bigint,
  size: number,
) {
  const bytes = new Uint8Array(size);
  storage.readInto(inode, 0n, bytes);
  return bytes;
}

describe("kernel revision apply regressions", () => {
  it("packs short hydration chunks into contiguous filesystem blocks", async () => {
    const fixture = rig([{ path: "/seed", bytes: new Uint8Array() }]);
    const contents = new Uint8Array([9, 8, 7, 6]);
    try {
      makeLocalFile(fixture.persistence.storage, "/seed", new Uint8Array());
      const before = await fixture.workspace.checkpoint("short-chunks-before", signal());
      const changed = fileChange(200n, ["/file"], [], contents);
      const after = await commit(fixture, before, "short-chunks-after", [changed]);
      const hydration: FileHydrationPort = {
        async fetch({ paths, signal: fetchSignal }) {
          if (fetchSignal.aborted) {
            return {
              status: "error",
              error: { code: "CANCELLED", message: "cancelled" },
            };
          }
          return {
            status: "ok",
            value: paths.map((path) => ({
              path,
              chunks: (async function* () {
                yield contents.slice(0, 2);
                yield contents.slice(2);
              })(),
            })),
          };
        },
      };
      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [changed],
        hydration,
        signal: signal(),
      });

      const inode = fixture.filesystem.lstat("/file").ino;
      expect(readFile(fixture.persistence.storage, inode, contents.length)).toEqual(contents);
    } finally {
      fixture.close();
    }
  });

  it("deduplicates overlapping retries and leaves a failed apply retryable", async () => {
    const oldBytes = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/file", bytes: oldBytes }]);
    const localInode = makeLocalFile(fixture.persistence.storage, "/file", oldBytes);
    const before = await fixture.workspace.checkpoint("overlap-before", signal());
    const changed = fileChange(201n, ["/renamed"], ["/file"], new Uint8Array([4, 3, 2, 1]));
    const after = await commit(fixture, before, "overlap-after", [changed]);
    let started!: () => void;
    let release!: () => void;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let fetchCount = 0;
    const hydration: FileHydrationPort = {
      async fetch(input) {
        fetchCount += 1;
        if (fetchCount === 1) {
          started();
          await gate;
        }
        return fixture.ports.hydration.fetch(input);
      },
    };
    try {
      fixture.storage.sql.exec(
        `CREATE TRIGGER fail_workspace_apply BEFORE UPDATE ON kernel_fs_inode WHEN OLD.ino = '${localInode}' BEGIN SELECT RAISE(ABORT, 'injected apply failure'); END`,
      );
      const first = fixture.workspace.apply({
        before,
        after,
        changedInodes: [changed],
        hydration,
        signal: signal(),
      });
      await fetchStarted;
      const duplicate = fixture.workspace.apply({
        before,
        after,
        changedInodes: [changed],
        hydration,
        signal: signal(),
      });
      release();

      await expect(first).rejects.toThrow();
      await expect(duplicate).rejects.toThrow();
      expect(fetchCount).toBe(1);
      expect(fixture.filesystem.lstat("/file").ino).toBe(localInode);
      fixture.storage.sql.exec("DROP TRIGGER fail_workspace_apply");

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [changed],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      expect(readFile(fixture.persistence.storage, localInode, 4)).toEqual(
        new Uint8Array([4, 3, 2, 1]),
      );
      expect(fixture.filesystem.lstat("/renamed").ino).toBe(localInode);
    } finally {
      release();
      fixture.close();
    }
  });

  it("rejects a revision root mounted from another storage", () => {
    const primary = rig([]);
    const foreign = rig([]);
    const primaryInode = makeLocalFile(primary.persistence.storage, "/victim", new Uint8Array([1]));
    const foreignInode = makeLocalFile(foreign.persistence.storage, "/victim", new Uint8Array([8]));
    const filesystem = new KernelFileSystem({
      mounts: [
        { path: "/", storage: primary.persistence.storage },
        { path: "/foreign", storage: foreign.persistence.storage },
      ],
      cwd: "/",
    });
    try {
      expect(() =>
        createFacetWorkspace({
          database: primary.storage,
          persistence: primary.persistence,
          filesystem,
          mountPath: "/foreign",
          initial: base,
          mount: async () => {
            throw new Error("Machine mount is outside this test");
          },
        }),
      ).toThrow(expect.objectContaining({ code: "EINVAL" }));
      expect(readFile(primary.persistence.storage, primaryInode, 1)).toEqual(new Uint8Array([1]));
      expect(readFile(foreign.persistence.storage, foreignInode, 1)).toEqual(new Uint8Array([8]));
    } finally {
      filesystem.dispose();
      primary.close();
      foreign.close();
    }
  });

  it("rejects a journal database that does not own the mounted storage", () => {
    const owner = rig([]);
    const other = rig([]);
    const inode = makeLocalFile(owner.persistence.storage, "/file", new Uint8Array([1]));
    const before = owner.persistence.storage.stat(owner.persistence.storage.root).ctimeNs;
    try {
      expect(() =>
        createFacetWorkspace({
          database: other.storage,
          persistence: owner.persistence,
          filesystem: owner.filesystem,
          mountPath: "/",
          initial: base,
          mount: async () => {
            throw new Error("Machine mount is outside this test");
          },
        }),
      ).toThrow(expect.objectContaining({ code: "EINVAL" }));
      expect(owner.persistence.storage.stat(owner.persistence.storage.root).ctimeNs).toBe(before);
      expect(readFile(owner.persistence.storage, inode, 1)).toEqual(new Uint8Array([1]));
    } finally {
      owner.close();
      other.close();
    }
  });

  it("moves a directory before looking up its new child path", async () => {
    const bytes = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/old/file", bytes }]);
    try {
      const inode = makeLocalPath(fixture.persistence.storage, "/old/file", bytes);
      const before = await fixture.workspace.checkpoint("directory-move-before", signal());
      const directory = directoryChange(300n, "/new", ["/old"]);
      const file = fileChange(301n, ["/new/file"], ["/old/file"], new Uint8Array([7, 8]));
      const after = await commit(fixture, before, "directory-move-after", [directory, file]);

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [directory, file],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      expect(fixture.filesystem.lstat("/new/file").ino).toBe(inode);
      expect(readFile(fixture.persistence.storage, inode, 2)).toEqual(new Uint8Array([7, 8]));
      expect(() => fixture.filesystem.lstat("/old")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      fixture.close();
    }
  });

  it("moves a surviving child before removing its deleted parent", async () => {
    const bytes = new Uint8Array([1, 2]);
    const fixture = rig([{ path: "/old/file", bytes }]);
    try {
      const inode = makeLocalPath(fixture.persistence.storage, "/old/file", bytes);
      const before = await fixture.workspace.checkpoint("directory-delete-before", signal());
      const file = fileChange(400n, ["/file"], ["/old/file"], new Uint8Array([5, 6]));
      const directory = directoryDeletion(401n, "/old");
      const after = await commit(fixture, before, "directory-delete-after", [file, directory]);

      await fixture.workspace.apply({
        before,
        after,
        changedInodes: [file, directory],
        hydration: fixture.ports.hydration,
        signal: signal(),
      });
      expect(fixture.filesystem.lstat("/file").ino).toBe(inode);
      expect(readFile(fixture.persistence.storage, inode, 2)).toEqual(new Uint8Array([5, 6]));
      expect(() => fixture.filesystem.lstat("/old")).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
    } finally {
      fixture.close();
    }
  });
});
