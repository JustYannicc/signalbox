import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage, FILE_CHUNK_BYTES } from "./FacetSqliteStorage.ts";
import { readStoragePersistence, runStorageProof } from "./StorageProof.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const clock = () => 1_800_000_000_000_000_001n;

describe("facet SQLite storage contract", () => {
  it("stores only written bytes for small files and appends, preserving overwritten suffixes", () => {
    const fixture = sqliteFixture();
    try {
      const fs = createFacetSqliteStorage(fixture.storage, clock);
      const ino = fs.create(fs.root, "small", { type: "file", exclusive: true });
      const stored = () => [
        ...fixture.storage.sql.exec(
          "SELECT part, length(bin) AS bytes FROM kernel_fs_chunk WHERE ino = ? ORDER BY part",
          ino.toString(),
        ),
      ];
      fs.write(ino, 0n, new Uint8Array([7]));
      expect(stored()).toEqual([{ part: 0, bytes: 1 }]);
      expect(fs.append(ino, new Uint8Array([8, 9]))).toEqual({ offset: 1n, bytesWritten: 2 });
      expect(stored()).toEqual([{ part: 0, bytes: 3 }]);
      fs.write(ino, 1n, new Uint8Array([6]));
      expect(stored()).toEqual([{ part: 0, bytes: 3 }]);
      const out = new Uint8Array(3);
      expect(fs.readInto(ino, 0n, out)).toBe(3);
      expect([...out]).toEqual([7, 6, 9]);
    } finally {
      fixture.close();
    }
  });

  it("stores only the sparse in-chunk prefix and keeps chunk indexes at 64 KiB", () => {
    const fixture = sqliteFixture();
    try {
      const fs = createFacetSqliteStorage(fixture.storage, clock);
      const ino = fs.create(fs.root, "sparse", { type: "file", exclusive: true });
      fs.write(ino, BigInt(FILE_CHUNK_BYTES + 5), new Uint8Array([7]));
      expect([
        ...fixture.storage.sql.exec(
          "SELECT part, length(bin) AS bytes FROM kernel_fs_chunk WHERE ino = ? ORDER BY part",
          ino.toString(),
        ),
      ]).toEqual([{ part: 1, bytes: 6 }]);
      const out = new Uint8Array(FILE_CHUNK_BYTES + 8).fill(255);
      expect(fs.readInto(ino, 0n, out)).toBe(FILE_CHUNK_BYTES + 6);
      expect(out.subarray(0, FILE_CHUNK_BYTES + 5)).toEqual(new Uint8Array(FILE_CHUNK_BYTES + 5));
      expect([...out.subarray(FILE_CHUNK_BYTES + 5)]).toEqual([7, 255, 255]);
    } finally {
      fixture.close();
    }
  });

  it("shrinks the stored tail and regrows with zeros instead of discarded bytes", () => {
    const fixture = sqliteFixture();
    try {
      const fs = createFacetSqliteStorage(fixture.storage, clock);
      const ino = fs.create(fs.root, "truncate", { type: "file", exclusive: true });
      fs.write(ino, 0n, new Uint8Array(FILE_CHUNK_BYTES + 5).fill(7));
      fs.truncate(ino, 3n);
      const stored = () => [
        ...fixture.storage.sql.exec(
          "SELECT part, length(bin) AS bytes FROM kernel_fs_chunk WHERE ino = ? ORDER BY part",
          ino.toString(),
        ),
      ];
      expect(stored()).toEqual([{ part: 0, bytes: 3 }]);
      fs.truncate(ino, 9n);
      expect(stored()).toEqual([{ part: 0, bytes: 3 }]);
      const out = new Uint8Array(10).fill(255);
      expect(fs.readInto(ino, 0n, out)).toBe(9);
      expect([...out]).toEqual([7, 7, 7, 0, 0, 0, 0, 0, 0, 255]);
      fs.write(ino, 7n, new Uint8Array([9]));
      expect(stored()).toEqual([{ part: 0, bytes: 8 }]);
      expect(fs.readInto(ino, 0n, out)).toBe(9);
      expect([...out]).toEqual([7, 7, 7, 0, 0, 0, 0, 9, 0, 255]);
    } finally {
      fixture.close();
    }
  });

  it("keeps inode identity, sparse data and namespace invariants", () => {
    const fixture = sqliteFixture();
    try {
      const fs = createFacetSqliteStorage(fixture.storage, clock);
      expect(runStorageProof(fs)).toEqual({
        ok: true,
        checks: expect.arrayContaining([expect.objectContaining({ ok: true })]),
      });
      expect(readStoragePersistence(createFacetSqliteStorage(fixture.storage, clock)).ok).toBe(
        true,
      );
    } finally {
      fixture.close();
    }
  });

  it("rolls back chunk bytes and metadata together when a write fails", () => {
    const fixture = sqliteFixture();
    try {
      const fs = createFacetSqliteStorage(fixture.storage, clock);
      const ino = fs.create(fs.root, "file", { type: "file", exclusive: true });
      fs.write(ino, 0n, new Uint8Array([1, 2, 3]));
      fixture.storage.sql.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON kernel_fs_inode
        WHEN OLD.ino = '${ino}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      expect(() => fs.write(ino, 1n, new Uint8Array([9, 9, 9]))).toThrow("injected failure");
      const out = new Uint8Array(4).fill(255);
      expect(fs.readInto(ino, 0n, out)).toBe(3);
      expect([...out]).toEqual([1, 2, 3, 255]);
      expect(fs.stat(ino).size).toBe(3n);
    } finally {
      fixture.close();
    }
  });

  it("cleans lost-incarnation unlinked inodes while preserving monotonic IDs and named files", () => {
    const fixture = sqliteFixture();
    try {
      const first = createFacetSqliteStorage(fixture.storage, clock);
      const lost = first.create(first.root, "lost", { type: "file", exclusive: true });
      first.write(lost, 0n, new Uint8Array([7]));
      first.unlink(first.root, "lost", { directory: false });
      const second = createFacetSqliteStorage(fixture.storage, clock);
      expect(() => second.stat(lost)).toThrow(expect.objectContaining({ code: "ENOENT" }));
      const next = second.create(second.root, "next", { type: "file", exclusive: true });
      expect(next).toBeGreaterThan(lost);
      expect([
        ...fixture.storage.sql.exec("SELECT * FROM kernel_fs_chunk WHERE ino = ?", lost.toString()),
      ]).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
});
