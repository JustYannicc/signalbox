import { describe, expect, it } from "vite-plus/test";
import { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import type { ChangedInode, CommitInode, FilePersistencePorts } from "./FilePersistencePorts.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const at = { repository: "repo", fork: "test", commit: "initial" };
const retry = { status: "error", error: { code: "IO_ERROR", message: "retry" } } as const;

function rig() {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const captured: Array<readonly CommitInode[]> = [];
  const ports: FilePersistencePorts = {
    hydration: {
      async fetch() {
        throw new Error("No hydration");
      },
    },
    commits: {
      async commit({ changedInodes }) {
        captured.push(changedInodes);
        return retry;
      },
    },
  };
  const open = () => createFacetFilePersistence(database.storage, () => 1n, { wakes, ports });
  const persistence = open();
  return {
    ...database,
    persistence,
    open,
    captured,
    commit: (owner: typeof persistence, turnId: string, changedInodes: readonly ChangedInode[]) =>
      owner.commitTurn({ at, turnId, changedInodes, signal: new AbortController().signal }),
    close() {
      persistence.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

describe("durable commit manifest format", () => {
  it("preserves multi-byte text and surrogate pairs across SQL part boundaries", async () => {
    const fixture = rig();
    let reopened: typeof fixture.persistence | undefined;
    try {
      const storage = fixture.persistence.storage;
      const inode = storage.create(storage.root, "file", { type: "file", exclusive: true });
      // Inode aliases can collectively exceed a SQLite value even when each path is small.
      const paths = Array.from({ length: 20_000 }, (_, index) => `/${index}-${"文件😀".repeat(8)}`);
      expect(
        await fixture.commit(fixture.persistence, "unicode", [{ inode, paths, removedPaths: [] }]),
      ).toEqual(retry);
      const parts = [
        ...fixture.storage.sql.exec(
          "SELECT json FROM kernel_fs_commit_manifest WHERE turn_id = 'unicode' ORDER BY part",
        ),
      ];
      expect(parts.length).toBeGreaterThan(1);
      expect(
        parts.every((row) => new TextEncoder().encode(String(row.json)).byteLength < 1024 * 1024),
      ).toBe(true);
      fixture.persistence.dispose();
      reopened = fixture.open();
      expect(await fixture.commit(reopened, "unicode", [])).toEqual(retry);
      expect(fixture.captured[1]?.[0]?.paths).toEqual(paths);
    } finally {
      reopened?.dispose();
      fixture.close();
    }
  });

  it("retries a legacy inline snapshot without recapturing its live inode", async () => {
    const fixture = rig();
    try {
      const inode = fixture.persistence.storage.create(fixture.persistence.storage.root, "old", {
        type: "file",
        exclusive: true,
      });
      const changed = [{ inode, paths: ["/old"], removedPaths: [] }];
      expect(await fixture.commit(fixture.persistence, "legacy", changed)).toEqual(retry);
      const manifest = [
        ...fixture.storage.sql.exec(
          "SELECT json FROM kernel_fs_commit_manifest WHERE turn_id = 'legacy' ORDER BY part",
        ),
      ]
        .map((row) => String(row.json))
        .join("");
      fixture.storage.sql.exec(
        "UPDATE kernel_fs_commit_snapshot SET manifest_json = ? WHERE turn_id = 'legacy'",
        manifest,
      );
      fixture.storage.sql.exec("DELETE FROM kernel_fs_commit_manifest WHERE turn_id = 'legacy'");
      fixture.persistence.storage.truncate(inode, 100n);
      expect(await fixture.commit(fixture.persistence, "legacy", [])).toEqual(retry);
      expect(fixture.captured[1]?.[0]?.stat?.size).toBe(0n);
    } finally {
      fixture.close();
    }
  });

  it.each(["missing", "gap", "extra"] as const)(
    "rejects a %s manifest part instead of sending a partial snapshot",
    async (fault) => {
      const fixture = rig();
      try {
        expect(await fixture.commit(fixture.persistence, "corrupt", [])).toEqual(retry);
        switch (fault) {
          case "missing":
            fixture.storage.sql.exec(
              "DELETE FROM kernel_fs_commit_manifest WHERE turn_id = 'corrupt'",
            );
            break;
          case "gap":
            fixture.storage.sql.exec(
              "UPDATE kernel_fs_commit_manifest SET part = 1 WHERE turn_id = 'corrupt'",
            );
            break;
          case "extra":
            fixture.storage.sql.exec(
              "INSERT INTO kernel_fs_commit_manifest VALUES ('corrupt', 1, '')",
            );
            break;
        }
        expect(await fixture.commit(fixture.persistence, "corrupt", [])).toMatchObject({
          status: "error",
          error: { message: expect.stringContaining("EIO") },
        });
        expect(fixture.captured).toHaveLength(1);
      } finally {
        fixture.close();
      }
    },
  );
});
