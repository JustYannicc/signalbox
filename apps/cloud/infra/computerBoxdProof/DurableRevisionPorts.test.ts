import { describe, expect, it } from "@effect/vitest";
import type { CommitInode, ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { FILE_CHUNK_BYTES, type FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createDurableProofRevisionPorts } from "./DurableRevisionPorts.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";

const at: ForkCommit = { repository: "proof", fork: "owned", commit: "before" };
const signal = new AbortController().signal;
const before = new Uint8Array([9, 8, 7]);
const change = (bytes: Uint8Array): CommitInode => ({
  inode: 42n,
  paths: ["/out.bin"],
  removedPaths: [],
  stat: {
    type: "file",
    size: BigInt(bytes.byteLength),
    nlink: 1n,
    atimeNs: 2n ** 60n,
    mtimeNs: 99n,
    ctimeNs: 101n,
  },
  symlinkTarget: null,
  posix: { mode: 0o6750, uid: 123, gid: 456 },
  async *readChunks() {
    yield bytes.subarray(0, 3);
    yield bytes.subarray(3);
  },
});
const commit = (
  proof: ReturnType<typeof createDurableProofRevisionPorts>,
  changedInodes: readonly CommitInode[],
  turnId = "turn-1",
  base = at,
) => proof.commits.commit({ at: base, changedInodes, turnId, signal });

describe("durable one-file proof revisions", () => {
  it("keeps immutable bytes and all metadata after replacing every adapter object", async () => {
    const sql = sqliteFixture();
    try {
      const bytes = Uint8Array.from(
        { length: FILE_CHUNK_BYTES * 2 + 73 },
        (_, index) => index % 251,
      );
      const result = await (async () => {
        const owner = createDurableProofRevisionPorts(sql.storage);
        owner.seedFile(at, "/out.bin", before);
        return commit(owner, [change(bytes)]);
      })();
      if (result.status !== "ok") throw new Error("Commit failed");
      const after = { ...at, commit: result.value.commit };
      const fresh = createDurableProofRevisionPorts(sql.storage);
      fresh.seedFile(at, "/out.bin", before);
      expect(fresh.inspectTree(at)?.["/out.bin"]?.data).toEqual(before);
      const entry = fresh.inspectTree(after)?.["/out.bin"];
      expect(entry).toEqual({
        inode: 42n,
        stat: change(bytes).stat,
        posix: change(bytes).posix,
        symlinkTarget: null,
        data: bytes,
      });
      entry!.data.fill(0);
      expect(fresh.inspectTree(after)?.["/out.bin"]?.data).toEqual(bytes);
      const fetch = await fresh.hydration.fetch({ at: after, paths: ["/out.bin"], signal });
      if (fetch.status !== "ok") throw new Error("Hydration failed");
      const parts = [];
      for await (const part of fetch.value[0]!.chunks) parts.push(...part);
      expect(new Uint8Array(parts)).toEqual(bytes);
      expect(fresh.committedTurns).toEqual([
        { at, turnId: "turn-1", receipt: result.value, tree: fresh.inspectTree(after) },
      ]);
      const replay = await commit(fresh, [
        {
          ...change(before),
          readChunks() {
            throw new Error("Replay consumed files");
          },
        },
      ]);
      expect(replay).toEqual(result);
      expect(fresh.committedTurns).toHaveLength(1);
      expect((await commit(fresh, [], "other-turn")).status).toBe("error");
      expect(() => fresh.seedFile(at, "/out.bin", new Uint8Array([0]))).toThrow("Immutable");
      expect(fresh.inspectTree(after)?.["/out.bin"]?.data).toEqual(bytes);
    } finally {
      sql.close();
    }
  });

  it("persists removal and never resets the head when the initial seed is replayed", async () => {
    const sql = sqliteFixture();
    try {
      const owner = createDurableProofRevisionPorts(sql.storage);
      owner.seedFile(at, "/out.bin", before);
      const result = await commit(owner, [
        { ...change(before), paths: [], removedPaths: ["/out.bin"], stat: null },
      ]);
      if (result.status !== "ok") throw new Error("Removal failed");
      const fresh = createDurableProofRevisionPorts(sql.storage);
      fresh.seedFile(at, "/out.bin", before);
      expect(fresh.inspectTree({ ...at, commit: result.value.commit })).toEqual({});
      expect(fresh.inspectTree(at)?.["/out.bin"]?.data).toEqual(before);
      expect(await commit(fresh, [], "new-turn")).toMatchObject({
        status: "error",
        error: { code: "STALE_COMMIT" },
      });
    } finally {
      sql.close();
    }
  });

  it("atomically rolls back snapshots, head, receipt and sequence on SQLite failure", async () => {
    const sql = sqliteFixture();
    try {
      let failReceipt = true;
      const storage: FacetStorage = {
        ...sql.storage,
        sql: {
          ...sql.storage.sql,
          exec(query, ...bindings) {
            if (failReceipt && query.startsWith("INSERT INTO proof_revision_turn"))
              throw new Error("injected receipt failure");
            return sql.storage.sql.exec(query, ...bindings);
          },
        },
      };
      const owner = createDurableProofRevisionPorts(storage);
      owner.seedFile(at, "/out.bin", before);
      expect(await commit(owner, [change(new Uint8Array([1, 2]))])).toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      const replacement = createDurableProofRevisionPorts(sql.storage);
      expect(replacement.inspectTree({ ...at, commit: "durable-proof-2" })).toBeUndefined();
      expect(replacement.committedTurns).toEqual([]);
      expect(replacement.inspectTree(at)?.["/out.bin"]?.data).toEqual(before);
      failReceipt = false;
      expect(await commit(owner, [change(before)])).toEqual({
        status: "ok",
        value: { commit: "durable-proof-2" },
      });
    } finally {
      sql.close();
    }
  });

  it("rejects unsupported trees, malformed streams and cancellation without advancing", async () => {
    const sql = sqliteFixture();
    try {
      const proof = createDurableProofRevisionPorts(sql.storage);
      proof.seedFile(at, "/out.bin", before);
      const file = change(before);
      const unsupported = [
        [file, file],
        [{ ...file, paths: ["/other.bin"] }],
        [{ ...file, paths: ["/out.bin", "/alias"] }],
        [{ ...file, stat: { ...file.stat!, type: "directory" as const } }],
        [{ ...file, stat: { ...file.stat!, size: 16_777_217n } }],
        [{ ...file, posix: { mode: -1, uid: 0, gid: 0 } }],
        [
          {
            ...file,
            async *readChunks() {
              yield new Uint8Array([1]);
            },
          },
        ],
        [
          {
            ...file,
            async *readChunks() {
              yield before;
              throw new Error("read failed");
            },
          },
        ],
      ];
      for (const files of unsupported)
        expect(await commit(proof, files)).toMatchObject({
          status: "error",
          error: { code: "IO_ERROR" },
        });
      const abort = new AbortController();
      const cancelled = {
        ...file,
        async *readChunks() {
          abort.abort();
          yield before;
        },
      };
      expect(
        await proof.commits.commit({
          at,
          turnId: "cancelled",
          changedInodes: [cancelled],
          signal: abort.signal,
        }),
      ).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
      expect(proof.committedTurns).toHaveLength(0);
      expect(await commit(proof, [file])).toEqual({
        status: "ok",
        value: { commit: "durable-proof-2" },
      });
    } finally {
      sql.close();
    }
  });
});
