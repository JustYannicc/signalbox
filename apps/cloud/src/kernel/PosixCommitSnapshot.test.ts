import { describe, expect, it } from "vite-plus/test";
import type {
  CommitInode,
  FileCommitReceipt,
  FilePersistencePorts,
  FilePersistenceResult,
  ForkCommit,
} from "./FilePersistencePorts.ts";
import { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import type { PosixMetadata } from "./PosixStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
const clock = () => 1_800_000_000_000_000_001n;
const failedResult: FilePersistenceResult<FileCommitReceipt> = {
  status: "error",
  error: { code: "IO_ERROR", message: "retry this turn" },
};
const succeededResult: FilePersistenceResult<FileCommitReceipt> = {
  status: "ok",
  value: { commit: "remote-commit" },
};

const portsWithCommit = (
  commit: FilePersistencePorts["commits"]["commit"],
): FilePersistencePorts => ({
  hydration: {
    async fetch() {
      return {
        status: "error",
        error: { code: "NOT_YET", message: "Hydration is unused in this test" },
      };
    },
  },
  commits: { commit },
});

const changed = (inode: bigint, path: string) => ({
  inode,
  paths: [path],
  removedPaths: [],
});

function rewriteManifest(
  database: ReturnType<typeof sqliteFixture>["storage"],
  turnId: string,
  rewrite: (entries: Array<Record<string, unknown>>) => void,
): void {
  const row = [
    ...database.sql.exec(
      "SELECT manifest_json FROM kernel_fs_commit_snapshot WHERE turn_id = ?",
      turnId,
    ),
  ][0];
  if (!row) throw new Error(`Missing snapshot for ${turnId}`);
  const entries: Array<Record<string, unknown>> = JSON.parse(String(row.manifest_json));
  rewrite(entries);
  database.sql.exec(
    "UPDATE kernel_fs_commit_snapshot SET manifest_json = ? WHERE turn_id = ?",
    JSON.stringify(entries),
    turnId,
  );
}

describe("POSIX commit snapshots", () => {
  it("replays captured metadata after chmod, chown, and reopening persistence", async () => {
    const database = sqliteFixture();
    const firstWakes = new KernelWakeRegistry();
    const reopenedWakes = new KernelWakeRegistry();
    const initial: PosixMetadata = { mode: 0o6751, uid: 42, gid: 24 };
    const captured: Array<CommitInode["posix"]> = [];
    let nextResult: FilePersistenceResult<FileCommitReceipt> = failedResult;
    const ports = portsWithCommit(async ({ changedInodes }) => {
      const posix = changedInodes[0]?.posix;
      captured.push(posix === undefined || posix === null ? posix : { ...posix });
      return nextResult;
    });
    const first = createFacetFilePersistence(database.storage, clock, {
      wakes: firstWakes,
      ports,
    });
    let reopened: ReturnType<typeof createFacetFilePersistence> | undefined;

    try {
      const inode = first.storage.create(first.storage.root, "file", {
        type: "file",
        exclusive: true,
      });
      first.storage.posix.initialize(inode, initial);
      const changedInodes = [changed(inode, "/file")];
      const input = {
        at: base,
        turnId: "posix-retry",
        changedInodes,
        signal: new AbortController().signal,
      };

      expect(await first.commitTurn(input)).toEqual(failedResult);
      first.storage.posix.chmod(inode, 0o640);
      first.storage.posix.chown(inode, { uid: 100, gid: 200 });
      first.dispose();

      nextResult = succeededResult;
      reopened = createFacetFilePersistence(database.storage, clock, {
        wakes: reopenedWakes,
        ports,
      });
      expect(await reopened.commitTurn(input)).toEqual(succeededResult);
      expect(captured).toEqual([initial, initial]);
    } finally {
      first.dispose();
      reopened?.dispose();
      firstWakes.dispose();
      reopenedWakes.dispose();
      database.close();
    }
  });

  it("passes null for legacy unknown metadata and deleted inodes", async () => {
    const database = sqliteFixture();
    const wakes = new KernelWakeRegistry();
    const captured = new Map<bigint, CommitInode["posix"]>();
    const persistence = createFacetFilePersistence(database.storage, clock, {
      wakes,
      ports: portsWithCommit(async ({ changedInodes }) => {
        for (const inode of changedInodes) {
          const posix = inode.posix;
          captured.set(inode.inode, posix === undefined || posix === null ? posix : { ...posix });
        }
        return failedResult;
      }),
    });

    try {
      const unknown = persistence.storage.create(persistence.storage.root, "unknown", {
        type: "file",
        exclusive: true,
      });
      persistence.storage.posix.initialize(unknown, { mode: 0o640, uid: 12, gid: 34 });
      database.storage.sql.exec("DELETE FROM kernel_fs_posix WHERE ino = ?", unknown.toString());

      const deleted = persistence.storage.create(persistence.storage.root, "deleted", {
        type: "file",
        exclusive: true,
      });
      persistence.storage.posix.initialize(deleted, { mode: 0o600, uid: 56, gid: 78 });
      persistence.storage.unlink(persistence.storage.root, "deleted", { directory: false });
      persistence.storage.release(deleted);

      const result = await persistence.commitTurn({
        at: base,
        turnId: "unknown-and-deleted",
        changedInodes: [
          changed(unknown, "/unknown"),
          { ...changed(deleted, "/deleted"), paths: [], removedPaths: ["/deleted"] },
        ],
        signal: new AbortController().signal,
      });

      expect(result).toEqual(failedResult);
      expect(captured.get(unknown)).toBeNull();
      expect(captured.get(deleted)).toBeNull();
    } finally {
      persistence.dispose();
      wakes.dispose();
      database.close();
    }
  });

  it("decodes manifests without POSIX metadata as null and rejects corrupt metadata", async () => {
    const database = sqliteFixture();
    const firstWakes = new KernelWakeRegistry();
    const reopenedWakes = new KernelWakeRegistry();
    const captured: Array<CommitInode["posix"]> = [];
    let nextResult: FilePersistenceResult<FileCommitReceipt> = failedResult;
    const ports = portsWithCommit(async ({ changedInodes }) => {
      const posix = changedInodes[0]?.posix;
      captured.push(posix === undefined || posix === null ? posix : { ...posix });
      return nextResult;
    });
    const first = createFacetFilePersistence(database.storage, clock, {
      wakes: firstWakes,
      ports,
    });
    let reopened: ReturnType<typeof createFacetFilePersistence> | undefined;

    try {
      const inode = first.storage.create(first.storage.root, "file", {
        type: "file",
        exclusive: true,
      });
      first.storage.posix.initialize(inode, { mode: 0o640, uid: 42, gid: 24 });
      const input = (turnId: string) => ({
        at: base,
        turnId,
        changedInodes: [changed(inode, "/file")],
        signal: new AbortController().signal,
      });

      expect(await first.commitTurn(input("legacy-manifest"))).toEqual(failedResult);
      expect(await first.commitTurn(input("corrupt-manifest"))).toEqual(failedResult);
      rewriteManifest(database.storage, "legacy-manifest", (entries) => {
        delete entries[0]!["posix"];
      });
      rewriteManifest(database.storage, "corrupt-manifest", (entries) => {
        entries[0]!["posix"] = { mode: 0o10000, uid: 42, gid: 24 };
      });

      first.dispose();
      reopened = createFacetFilePersistence(database.storage, clock, {
        wakes: reopenedWakes,
        ports,
      });
      nextResult = succeededResult;

      expect(await reopened.commitTurn(input("legacy-manifest"))).toEqual(succeededResult);
      expect(await reopened.commitTurn(input("corrupt-manifest"))).toMatchObject({
        status: "error",
        error: { code: "IO_ERROR", message: expect.stringContaining("EIO") },
      });
      expect(captured).toEqual([
        { mode: 0o640, uid: 42, gid: 24 },
        { mode: 0o640, uid: 42, gid: 24 },
        null,
      ]);
    } finally {
      first.dispose();
      reopened?.dispose();
      firstWakes.dispose();
      reopenedWakes.dispose();
      database.close();
    }
  });
});
