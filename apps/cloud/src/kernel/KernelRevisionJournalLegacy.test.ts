import { describe, expect, it } from "vite-plus/test";
import { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import type { CommitInode, FilePersistencePorts } from "./FilePersistencePorts.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelRevisionWorkspace } from "./KernelRevisionWorkspace.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const initial = { repository: "repo", fork: "test", commit: "base" };
const signal = () => new AbortController().signal;

function fixture() {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const captured: Array<{ entries: readonly CommitInode[]; bytes: number[] }> = [];
  let fail = true;
  const ports: FilePersistencePorts = {
    hydration: {
      async fetch() {
        throw new Error("No lazy files");
      },
    },
    commits: {
      async commit({ changedInodes }) {
        const bytes: number[] = [];
        for (const entry of changedInodes)
          for await (const chunk of entry.readChunks()) bytes.push(...chunk);
        captured.push({ entries: changedInodes, bytes });
        return fail
          ? { status: "error", error: { code: "IO_ERROR", message: "retry" } }
          : { status: "ok", value: { commit: `saved-${captured.length}` } };
      },
    },
  };
  const persistence = createFacetFilePersistence(database.storage, () => 1n, { wakes, ports });
  const inode = persistence.storage.create(persistence.storage.root, "file", {
    type: "file",
    exclusive: true,
  });
  persistence.storage.write(inode, 0n, new Uint8Array([1]));
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
  });
  const open = () =>
    createKernelRevisionWorkspace({
      database: database.storage,
      persistence,
      filesystem,
      mountPath: "/",
      initial,
    });
  const workspace = open();
  const write = (value: number) => persistence.storage.write(inode, 0n, new Uint8Array([value]));
  const inline = (key: string, value: unknown) =>
    String(value).startsWith("chunked-manifest-v1:")
      ? [
          ...database.storage.sql.exec(
            "SELECT json FROM kernel_fs_workspace_manifest WHERE owner_key = ? ORDER BY part",
            key,
          ),
        ]
          .map((row) => String(row.json))
          .join("")
      : String(value);
  return {
    database,
    captured,
    workspace,
    open,
    write,
    inline,
    succeed() {
      fail = false;
    },
    close() {
      filesystem.dispose();
      persistence.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

describe("workspace journal format compatibility", () => {
  it("removes every obsolete attempt's parts when the baseline advances", async () => {
    const test = fixture();
    try {
      test.write(2);
      await expect(test.workspace.checkpoint("failed-a", signal())).rejects.toThrow("retry");
      await expect(test.workspace.checkpoint("failed-b", signal())).rejects.toThrow("retry");
      test.succeed();
      await test.workspace.checkpoint("saved", signal());
      const db = test.database.storage;
      expect([...db.sql.exec("SELECT operation_id FROM kernel_fs_workspace_attempt")]).toEqual([]);
      expect([
        ...db.sql.exec("SELECT DISTINCT owner_key FROM kernel_fs_workspace_manifest"),
      ]).toEqual([{ owner_key: JSON.stringify(["state"]) }]);
    } finally {
      test.close();
    }
  });

  it("resumes legacy inline baseline and pending attempt values then publishes bounded state", async () => {
    const test = fixture();
    try {
      test.write(2);
      await expect(test.workspace.checkpoint("pending", signal())).rejects.toThrow("retry");
      const db = test.database.storage;
      const state = [...db.sql.exec("SELECT manifest_json FROM kernel_fs_workspace_state")][0]!;
      const attempt = [
        ...db.sql.exec(
          "SELECT manifest_json, changed_json, dirty_json FROM kernel_fs_workspace_attempt WHERE operation_id = 'pending'",
        ),
      ][0]!;
      db.transactionSync(() => {
        db.sql.exec(
          "UPDATE kernel_fs_workspace_state SET manifest_json = ?",
          test.inline(JSON.stringify(["state"]), state.manifest_json),
        );
        db.sql.exec(
          "UPDATE kernel_fs_workspace_attempt SET manifest_json = ?, changed_json = ?, dirty_json = ? WHERE operation_id = 'pending'",
          test.inline(JSON.stringify(["attempt", "pending", "manifest"]), attempt.manifest_json),
          test.inline(JSON.stringify(["attempt", "pending", "changed"]), attempt.changed_json),
          test.inline(JSON.stringify(["attempt", "pending", "dirty"]), attempt.dirty_json),
        );
        db.sql.exec("DELETE FROM kernel_fs_workspace_manifest");
      });
      test.succeed();
      const first = await test.open().checkpoint("pending", signal());
      expect(first.commit).toBe("saved-2");
      expect(test.captured.map((call) => call.bytes)).toEqual([[2], [2]]);
      expect(test.captured[1]?.entries.map((entry) => entry.paths)).toEqual([["/file"]]);
      expect([...db.sql.exec("SELECT operation_id FROM kernel_fs_workspace_attempt")]).toEqual([]);
      expect([
        ...db.sql.exec("SELECT DISTINCT owner_key FROM kernel_fs_workspace_manifest"),
      ]).toEqual([{ owner_key: JSON.stringify(["state"]) }]);
      test.write(3);
      const second = await test.open().checkpoint("next", signal());
      expect(second.commit).toBe("saved-3");
      expect(test.captured[2]?.bytes).toEqual([3]);
      expect(test.captured[2]?.entries.map((entry) => entry.paths)).toEqual([["/file"]]);
    } finally {
      test.close();
    }
  });

  it.each(["state", "manifest", "changed", "dirty"] as const)(
    "rejects missing %s parts before a remote commit",
    async (field) => {
      const test = fixture();
      try {
        test.write(2);
        await expect(test.workspace.checkpoint("pending", signal())).rejects.toThrow("retry");
        const key =
          field === "state"
            ? JSON.stringify(["state"])
            : JSON.stringify(["attempt", "pending", field]);
        test.database.storage.sql.exec(
          "DELETE FROM kernel_fs_workspace_manifest WHERE owner_key = ?",
          key,
        );
        test.succeed();
        if (field === "state") expect(test.open).toThrow("The facet workspace journal is invalid");
        else
          await expect(test.open().checkpoint("pending", signal())).rejects.toThrow(
            "The facet workspace journal is invalid",
          );
        expect(test.captured).toHaveLength(1);
      } finally {
        test.close();
      }
    },
  );
});
