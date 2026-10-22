import { expect, it } from "vite-plus/test";
import type { FacetStorage } from "./FacetSqliteStorage.ts";
import type { Inode } from "./storage.ts";
import {
  installJournalValues,
  readAttemptValues,
  readStateManifest,
  writeAttemptValues,
  writeStateManifest,
} from "./KernelRevisionJournalStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const MEBIBYTE = 1024 * 1024;
const encoder = new TextEncoder();

// Size coverage needs large values, not 65,000 filesystem mutations and snapshot reads.
const entries = Array.from({ length: 65_000 }, (_, index) => ({
  inode: `7${String(index + 1).padStart(31, "0")}`,
  paths: [`/file-${String(index + 1).padStart(5, "0")}.txt`],
  stat: {
    type: "file",
    size: "0",
    nlink: "1",
    atimeNs: "100",
    mtimeNs: "101",
    ctimeNs: "102",
  },
  symlinkTarget: null,
  posix: { mode: 0o644, uid: 1000, gid: 1000 },
}));
const manifest = JSON.stringify(entries);
const changed = entries.map((entry) => ({
  inode: BigInt(entry.inode) as Inode,
  paths: entry.paths,
  removedPaths: [],
}));
const dirty = entries.map((entry) => ({ inode: entry.inode, version: 1 }));

it("round-trips 65,000-entry journal values with every SQLite binding below 1 MiB", () => {
  const fixture = sqliteFixture();
  let largestBinding = 0;
  const database: FacetStorage = {
    ...fixture.storage,
    sql: {
      get databaseSize() {
        return fixture.storage.sql.databaseSize;
      },
      exec(query, ...bindings) {
        for (const value of bindings) {
          if (typeof value !== "string") continue;
          const size = encoder.encode(value).byteLength;
          largestBinding = Math.max(largestBinding, size);
          if (size >= MEBIBYTE) throw new Error(`Oversized SQLite binding: ${size} bytes`);
        }
        return fixture.storage.sql.exec(query, ...bindings);
      },
    },
  };
  try {
    installJournalValues(database);
    const values = { manifest, changed, dirty };
    const headers = database.transactionSync(() => ({
      state: writeStateManifest(database, manifest),
      attempt: writeAttemptValues(database, "large", values),
    }));
    expect(readStateManifest(database, headers.state)).toBe(manifest);
    const restored = readAttemptValues(database, "large", {
      manifest_json: headers.attempt.manifest,
      changed_json: headers.attempt.changed,
      dirty_json: headers.attempt.dirty,
    });
    expect(restored.manifest).toBe(manifest);
    expect(restored.changed).toEqual(changed);
    expect(restored.dirty).toEqual(dirty);
    for (const key of [
      JSON.stringify(["state"]),
      ...["manifest", "changed", "dirty"].map((field) =>
        JSON.stringify(["attempt", "large", field]),
      ),
    ]) {
      const rows = [
        ...database.sql.exec(
          "SELECT json FROM kernel_fs_workspace_manifest WHERE owner_key = ?",
          key,
        ),
      ];
      const bytes = rows.reduce(
        (total, row) => total + encoder.encode(String(row.json)).byteLength,
        0,
      );
      expect(bytes).toBeGreaterThan(2 * MEBIBYTE);
    }
    expect(largestBinding).toBeGreaterThan(0);
    expect(largestBinding).toBeLessThan(MEBIBYTE);
  } finally {
    fixture.close();
  }
});
