// @effect-diagnostics nodeBuiltinImport:off - hashes invented fixture data in an isolated test database.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import type { ChangedInode, CommitInode, FilePersistencePorts } from "./FilePersistencePorts.ts";
import type { FacetStorage } from "./FacetSqliteStorage.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const base = { repository: "repo", fork: "test", commit: "initial" };
const now = 1_800_000_000_000_000_001n;
const signal = () => new AbortController().signal;
const retry = { status: "error", error: { code: "IO_ERROR", message: "retry" } } as const;
const filename = (inode: bigint) => `invented-${inode}-${"long-name-".repeat(8)}.txt`;

function guardedDatabase() {
  const database = sqliteFixture();
  const guard = { largestBinding: 0, manifestWrites: 0, crashAfter: Infinity };
  const storage: FacetStorage = {
    ...database.storage,
    sql: {
      databaseSize: 0,
      exec(query, ...bindings) {
        for (const value of bindings) {
          const size =
            typeof value === "string"
              ? new TextEncoder().encode(value).byteLength
              : value instanceof ArrayBuffer
                ? value.byteLength
                : 0;
          guard.largestBinding = Math.max(guard.largestBinding, size);
          if (size > 2 * 1024 * 1024) throw new Error("SQLITE_TOOBIG");
        }
        const result = database.storage.sql.exec(query, ...bindings);
        if (query.startsWith("INSERT INTO kernel_fs_commit_manifest")) {
          guard.manifestWrites++;
          if (guard.manifestWrites === guard.crashAfter) throw new Error("injected crash");
        }
        return result;
      },
    },
  };
  return { storage, guard, close: database.close };
}

function seedFiles(database: FacetStorage, count: number): ChangedInode[] {
  database.transactionSync(() => {
    database.sql.exec(
      "WITH RECURSIVE files(ino) AS (SELECT 2 UNION ALL SELECT ino + 1 FROM files WHERE ino < ?) INSERT INTO kernel_fs_inode SELECT CAST(ino AS TEXT), 'file', '8', 1, ?, ?, ?, NULL FROM files",
      count + 1,
      now.toString(),
      now.toString(),
      now.toString(),
    );
    database.sql.exec(
      "INSERT INTO kernel_fs_chunk SELECT ino, 0, CAST(printf('%08d', CAST(ino AS INTEGER)) AS BLOB) FROM kernel_fs_inode WHERE type = 'file'",
    );
    database.sql.exec(
      "INSERT INTO kernel_fs_posix SELECT ino, 416, 42, 24 FROM kernel_fs_inode WHERE type = 'file'",
    );
  });
  return Array.from({ length: count }, (_, index) => {
    const inode = BigInt(index + 2);
    return { inode, paths: [`/${filename(inode)}`], removedPaths: [] };
  });
}

function metadata(entry: Omit<CommitInode, "readChunks">): string {
  return JSON.stringify(
    {
      inode: entry.inode,
      paths: entry.paths,
      removedPaths: entry.removedPaths,
      stat: entry.stat,
      symlinkTarget: entry.symlinkTarget,
      posix: entry.posix,
    },
    (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

function expectedDigest(changed: readonly ChangedInode[]): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const entry of changed) {
    hash.update(
      metadata({
        ...entry,
        stat: { type: "file", size: 8n, nlink: 1n, atimeNs: now, mtimeNs: now, ctimeNs: now },
        symlinkTarget: null,
        posix: { mode: 0o640, uid: 42, gid: 24 },
      }),
    );
    hash.update(entry.inode.toString().padStart(8, "0"));
  }
  return hash.digest("hex");
}

async function snapshotDigest(entries: readonly CommitInode[]): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for (const entry of entries) {
    hash.update(metadata(entry));
    for await (const chunk of entry.readChunks()) hash.update(chunk);
  }
  return hash.digest("hex");
}

const portsWithCommit = (
  commit: FilePersistencePorts["commits"]["commit"],
): FilePersistencePorts => ({
  hydration: {
    async fetch() {
      throw new Error("No lazy files in this fixture");
    },
  },
  commits: { commit },
});

describe("large durable commit snapshots", () => {
  it("restores all bytes and metadata for 65,000 entries after reopening with bounded SQL values", async () => {
    const database = guardedDatabase();
    const wakes = new KernelWakeRegistry();
    const captures: string[] = [];
    const ports = portsWithCommit(async ({ changedInodes }) => {
      captures.push(await snapshotDigest(changedInodes));
      return captures.length < 3 ? retry : { status: "ok", value: { commit: "saved" } };
    });
    const first = createFacetFilePersistence(database.storage, () => now, { wakes, ports });
    let reopened: ReturnType<typeof createFacetFilePersistence> | undefined;
    try {
      const changed = seedFiles(database.storage, 65_000);
      const expected = expectedDigest(changed);
      expect(
        await first.commitTurn({
          at: base,
          turnId: "large",
          changedInodes: changed,
          signal: signal(),
        }),
      ).toEqual(retry);
      expect(captures).toEqual([expected]);
      expect(database.guard.largestBinding).toBeLessThan(1024 * 1024);
      database.storage.sql.exec(
        "UPDATE kernel_fs_chunk SET bin = ? WHERE ino = '2'",
        new Uint8Array([99]).buffer,
      );
      database.storage.sql.exec("UPDATE kernel_fs_posix SET mode = 0 WHERE ino = '2'");
      first.dispose();
      reopened = createFacetFilePersistence(database.storage, () => now, { wakes, ports });
      expect(
        await reopened.commitTurn({
          at: base,
          turnId: "large",
          changedInodes: [],
          signal: signal(),
        }),
      ).toEqual(retry);
      expect(captures).toEqual([expected, expected]);
      expect(
        await reopened.commitTurn({
          at: base,
          turnId: "large",
          changedInodes: [],
          signal: signal(),
        }),
      ).toEqual({ status: "ok", value: { commit: "saved" } });
      expect(captures).toEqual([expected, expected, expected]);
      for (const table of [
        "kernel_fs_commit_snapshot",
        "kernel_fs_commit_manifest",
        "kernel_fs_commit_snapshot_chunk",
      ]) {
        expect([...database.storage.sql.exec(`SELECT turn_id FROM ${table}`)]).toEqual([]);
      }
      expect(
        await reopened.commitTurn({
          at: base,
          turnId: "large",
          changedInodes: [],
          signal: signal(),
        }),
      ).toEqual({ status: "ok", value: { commit: "saved" } });
      expect(captures).toHaveLength(3);
    } finally {
      first.dispose();
      reopened?.dispose();
      wakes.dispose();
      database.close();
    }
  });

  it("rolls back a crash after writing a manifest part without disturbing the previous snapshot", async () => {
    const database = guardedDatabase();
    const wakes = new KernelWakeRegistry();
    const captures: Array<{ turnId: string; digest: string }> = [];
    const ports = portsWithCommit(async ({ turnId, changedInodes }) => {
      captures.push({ turnId, digest: await snapshotDigest(changedInodes) });
      return retry;
    });
    const persistence = createFacetFilePersistence(database.storage, () => now, { wakes, ports });
    try {
      const changed = seedFiles(database.storage, 4000);
      const expected = expectedDigest(changed);
      const commit = (turnId: string) =>
        persistence.commitTurn({ at: base, turnId, changedInodes: changed, signal: signal() });
      expect(await commit("previous")).toEqual(retry);
      database.guard.crashAfter = database.guard.manifestWrites + 2;
      expect(await commit("crashed")).toMatchObject({
        status: "error",
        error: { message: expect.stringContaining("injected crash") },
      });
      expect([
        ...database.storage.sql.exec(
          "SELECT turn_id FROM kernel_fs_commit_snapshot WHERE turn_id = 'crashed'",
        ),
      ]).toEqual([]);
      expect([
        ...database.storage.sql.exec(
          "SELECT turn_id FROM kernel_fs_commit_snapshot_chunk WHERE turn_id = 'crashed'",
        ),
      ]).toEqual([]);
      expect([
        ...database.storage.sql.exec(
          "SELECT turn_id FROM kernel_fs_commit_manifest WHERE turn_id = 'crashed'",
        ),
      ]).toEqual([]);
      expect(await commit("previous")).toEqual(retry);
      database.guard.crashAfter = Infinity;
      expect(await commit("crashed")).toEqual(retry);
      expect(captures).toEqual([
        { turnId: "previous", digest: expected },
        { turnId: "previous", digest: expected },
        { turnId: "crashed", digest: expected },
      ]);
    } finally {
      persistence.dispose();
      wakes.dispose();
      database.close();
    }
  });
});
