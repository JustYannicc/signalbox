import { describe, expect, it } from "vite-plus/test";
import type { ChangedInode, FilePersistencePorts, ForkCommit } from "./FilePersistencePorts.ts";
import { createFacetFilePersistence } from "./FacetFilePersistence.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelWakeRegistry } from "./KernelAbi.ts";
import { createMemoryFilePersistencePorts } from "./MemoryFilePersistencePorts.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
const clock = () => 1_800_000_000_000_000_001n;

function rig(ports?: FilePersistencePorts) {
  const database = sqliteFixture();
  const wakes = new KernelWakeRegistry();
  const persistence = createFacetFilePersistence(database.storage, clock, {
    wakes,
    ...(ports ? { ports } : {}),
  });
  return {
    ...database,
    wakes,
    persistence,
    close() {
      persistence.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

function readAttempt(
  persistence: ReturnType<typeof createFacetFilePersistence>,
  inode: bigint,
  size: number,
) {
  return persistence.attempt(() => {
    const bytes = new Uint8Array(size);
    persistence.storage.readInto(inode, 0n, bytes);
    return bytes;
  });
}

async function wake(
  result: ReturnType<ReturnType<typeof createFacetFilePersistence>["attempt"]>,
  wakes: KernelWakeRegistry,
) {
  if (result.status !== "would_block") throw new Error("Expected hydration to block");
  const resultOfWait = await wakes.wait(result.wakeToken);
  if (resultOfWait.status !== "ok") throw new Error(resultOfWait.error.message);
}

const failed = (code: "IO_ERROR") => ({
  status: "error" as const,
  error: { code, message: "injected persistence failure" },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("facet file persistence", () => {
  it("marks a sized file lazily, wakes for exact bytes, and preserves EAGAIN across raw reopen", async () => {
    const memory = createMemoryFilePersistencePorts();
    const bytes = new Uint8Array([2, 4, 6, 8]);
    memory.seedFile(base, "/lazy", bytes);
    const fixture = rig(memory);
    try {
      const inode = fixture.persistence.storage.create(fixture.persistence.storage.root, "lazy", {
        type: "file",
        exclusive: true,
      });
      fixture.persistence.storage.truncate(inode, BigInt(bytes.byteLength));
      fixture.persistence.markUnhydrated({ inode, path: "/lazy", at: base, size: 4n });

      const blocked = readAttempt(fixture.persistence, inode, bytes.byteLength);
      expect(blocked.status).toBe("would_block");
      const reopened = createFacetSqliteStorage(fixture.storage, clock);
      expect(() => reopened.readInto(inode, 0n, new Uint8Array(4))).toThrow(
        expect.objectContaining({ code: "EAGAIN" }),
      );

      await wake(blocked, fixture.wakes);
      const hydrated = readAttempt(fixture.persistence, inode, bytes.byteLength);
      expect(hydrated).toEqual({ status: "ok", value: bytes });
      expect(memory.fetchCalls).toMatchObject([{ at: base, paths: ["/lazy"], status: "ok" }]);
    } finally {
      fixture.close();
    }
  });

  it("preserves an in-flight first chunk when a raw SQLite adapter is reopened", async () => {
    const memory = createMemoryFilePersistencePorts();
    const firstChunk = new Uint8Array(64 * 1024).fill(5);
    const lastChunk = new Uint8Array([6, 7, 8]);
    const expected = new Uint8Array(firstChunk.byteLength + lastChunk.byteLength);
    expected.set(firstChunk);
    expected.set(lastChunk, firstChunk.byteLength);
    memory.seedFile(base, "/big", expected);
    const firstConsumed = deferred();
    const continueFetch = deferred();
    const fixture = rig({
      commits: memory.commits,
      hydration: {
        async fetch() {
          return {
            status: "ok",
            value: [
              {
                path: "/big",
                chunks: (async function* () {
                  yield firstChunk;
                  firstConsumed.resolve();
                  await continueFetch.promise;
                  yield lastChunk;
                })(),
              },
            ],
          };
        },
      },
    });
    try {
      const inode = fixture.persistence.storage.create(fixture.persistence.storage.root, "big", {
        type: "file",
        exclusive: true,
      });
      fixture.persistence.storage.truncate(inode, BigInt(expected.byteLength));
      fixture.persistence.markUnhydrated({
        inode,
        path: "/big",
        at: base,
        size: BigInt(expected.byteLength),
      });

      const blocked = readAttempt(fixture.persistence, inode, expected.byteLength);
      const wakeResult = wake(blocked, fixture.wakes);
      await firstConsumed.promise;
      const reopened = createFacetSqliteStorage(fixture.storage, clock);
      expect(() => reopened.readInto(inode, 0n, new Uint8Array(expected.byteLength))).toThrow(
        expect.objectContaining({ code: "EAGAIN" }),
      );
      continueFetch.resolve();
      await wakeResult;

      expect(readAttempt(fixture.persistence, inode, expected.byteLength)).toEqual({
        status: "ok",
        value: expected,
      });
    } finally {
      continueFetch.resolve();
      fixture.close();
    }
  });

  it("keeps partial hydration hidden and requires an explicit retry after a fetch error", async () => {
    const memory = createMemoryFilePersistencePorts();
    const bytes = new Uint8Array([1, 3, 5, 7]);
    memory.seedFile(base, "/partial", bytes);
    let fetchCount = 0;
    const ports: FilePersistencePorts = {
      commits: memory.commits,
      hydration: {
        async fetch(input) {
          fetchCount++;
          if (fetchCount === 1) {
            return {
              status: "ok",
              value: [
                {
                  path: "/partial",
                  chunks: (async function* () {
                    yield new Uint8Array([1, 3]);
                    throw new Error("truncated stream");
                  })(),
                },
              ],
            };
          }
          return memory.hydration.fetch(input);
        },
      },
    };
    const fixture = rig(ports);
    try {
      const inode = fixture.persistence.storage.create(
        fixture.persistence.storage.root,
        "partial",
        {
          type: "file",
          exclusive: true,
        },
      );
      fixture.persistence.storage.truncate(inode, BigInt(bytes.byteLength));
      fixture.persistence.markUnhydrated({ inode, path: "/partial", at: base, size: 4n });
      const before = fixture.persistence.storage.stat(inode);

      const blocked = readAttempt(fixture.persistence, inode, bytes.byteLength);
      await wake(blocked, fixture.wakes);
      expect(readAttempt(fixture.persistence, inode, bytes.byteLength)).toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      expect(readAttempt(fixture.persistence, inode, bytes.byteLength)).toMatchObject({
        status: "error",
        error: { code: "IO_ERROR" },
      });
      expect(fixture.persistence.storage.stat(inode)).toEqual(before);
      expect(() =>
        createFacetSqliteStorage(fixture.storage, clock).readInto(inode, 0n, new Uint8Array(4)),
      ).toThrow(expect.objectContaining({ code: "EAGAIN" }));

      fixture.persistence.retryHydration(inode);
      const retry = readAttempt(fixture.persistence, inode, bytes.byteLength);
      await wake(retry, fixture.wakes);
      expect(readAttempt(fixture.persistence, inode, bytes.byteLength)).toEqual({
        status: "ok",
        value: bytes,
      });
      expect(fetchCount).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("maps the disconnected persistence port to UNSUPPORTED", async () => {
    const fixture = rig();
    try {
      const inode = fixture.persistence.storage.create(
        fixture.persistence.storage.root,
        "missing",
        {
          type: "file",
          exclusive: true,
        },
      );
      fixture.persistence.storage.truncate(inode, 1n);
      fixture.persistence.markUnhydrated({ inode, path: "/missing", at: base, size: 1n });
      const blocked = readAttempt(fixture.persistence, inode, 1);
      await wake(blocked, fixture.wakes);
      expect(readAttempt(fixture.persistence, inode, 1)).toMatchObject({
        status: "error",
        error: { code: "UNSUPPORTED" },
      });
    } finally {
      fixture.close();
    }
  });

  it("retries commits from a stable turn snapshot and preserves rename, deletion, and symlink paths", async () => {
    const memory = createMemoryFilePersistencePorts();
    memory.seedFile(base, "/old", new Uint8Array([1, 2]));
    memory.seedFile(base, "/gone", new Uint8Array([3]));
    memory.seedFile(base, "/keep", new Uint8Array([4]));
    let letFirstCommitEnter!: () => void;
    let releaseFirstCommit!: () => void;
    const entered = new Promise<void>((resolve) => {
      letFirstCommitEnter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    let calls = 0;
    const ports: FilePersistencePorts = {
      hydration: memory.hydration,
      commits: {
        async commit(input) {
          calls++;
          if (calls === 1) {
            letFirstCommitEnter();
            await gate;
            return failed("IO_ERROR");
          }
          return memory.commits.commit(input);
        },
      },
    };
    const fixture = rig(ports);
    try {
      const fs = fixture.persistence.storage;
      const old = fs.create(fs.root, "old", { type: "file", exclusive: true });
      fs.write(old, 0n, new Uint8Array([1, 2]));
      const oldStat = fs.stat(old);
      fs.rename(fs.root, "old", fs.root, "new");
      const gone = fs.create(fs.root, "gone", { type: "file", exclusive: true });
      fs.write(gone, 0n, new Uint8Array([3]));
      fs.unlink(fs.root, "gone", { directory: false });
      fs.release(gone);
      const link = fs.create(fs.root, "link", { type: "symlink", exclusive: true, target: "new" });
      const renamedPaths = ["/new"];
      const changedInodes: ChangedInode[] = [
        { inode: old, paths: renamedPaths, removedPaths: ["/old"] },
        { inode: gone, paths: [], removedPaths: ["/gone"] },
        { inode: link, paths: ["/link"], removedPaths: [] },
      ];
      const input = {
        at: base,
        turnId: "stable-turn",
        changedInodes,
        signal: new AbortController().signal,
      };
      const first = fixture.persistence.commitTurn(input);
      await entered;

      fs.write(old, 0n, new Uint8Array([8, 9]));
      fs.setTimes(old, { mtimeNs: 88n });
      fs.rename(fs.root, "new", fs.root, "moved");
      renamedPaths[0] = "/mutated-after-snapshot";
      releaseFirstCommit();
      expect(await first).toMatchObject({ status: "error", error: { code: "IO_ERROR" } });

      const retry = await fixture.persistence.commitTurn(input);
      expect(retry.status).toBe("ok");
      if (retry.status !== "ok") throw new Error(retry.error.message);
      const tree = memory.inspectTree({ ...base, commit: retry.value.commit })!;
      expect(tree["/new"]!.data).toEqual(new Uint8Array([1, 2]));
      expect(tree["/new"]!.stat).toEqual(oldStat);
      expect(tree["/mutated-after-snapshot"]).toBeUndefined();
      expect(tree["/old"]).toBeUndefined();
      expect(tree["/gone"]).toBeUndefined();
      expect(tree["/keep"]!.data).toEqual(new Uint8Array([4]));
      expect(tree["/link"]).toMatchObject({ stat: { type: "symlink" }, symlinkTarget: "new" });
    } finally {
      fixture.close();
    }
  });

  it("commits deletion of an unhydrated, unlinked file without fetching it", async () => {
    const memory = createMemoryFilePersistencePorts();
    memory.seedFile(base, "/gone", new Uint8Array([1, 2, 3]));
    const fixture = rig(memory);
    try {
      const fs = fixture.persistence.storage;
      const inode = fs.create(fs.root, "gone", { type: "file", exclusive: true });
      fs.truncate(inode, 3n);
      fixture.persistence.markUnhydrated({ inode, path: "/gone", at: base, size: 3n });
      fs.unlink(fs.root, "gone", { directory: false });

      const result = await fixture.persistence.commitTurn({
        at: base,
        turnId: "delete-lazy",
        changedInodes: [{ inode, paths: [], removedPaths: ["/gone"] }],
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("ok");
      expect(memory.fetchCalls).toHaveLength(0);
      if (result.status !== "ok") throw new Error(result.error.message);
      expect(
        memory.inspectTree({ ...base, commit: result.value.commit })?.["/gone"],
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("replays a persisted turn receipt before inspecting new lazy inodes after reopen", async () => {
    const database = sqliteFixture();
    const memory = createMemoryFilePersistencePorts();
    memory.seedFile(base, "/unmodified", new Uint8Array([0]));
    let fetchCount = 0;
    let commitCount = 0;
    const ports: FilePersistencePorts = {
      hydration: {
        async fetch() {
          fetchCount++;
          return {
            status: "error",
            error: { code: "NOT_FOUND", message: "This retry must not fetch" },
          };
        },
      },
      commits: {
        async commit(input) {
          commitCount++;
          return memory.commits.commit(input);
        },
      },
    };
    const firstWakes = new KernelWakeRegistry();
    const first = createFacetFilePersistence(database.storage, clock, { wakes: firstWakes, ports });
    const secondWakes = new KernelWakeRegistry();
    let second: ReturnType<typeof createFacetFilePersistence> | undefined;
    try {
      const initial = first.storage.create(first.storage.root, "initial", {
        type: "file",
        exclusive: true,
      });
      first.storage.write(initial, 0n, new Uint8Array([1]));
      const original = await first.commitTurn({
        at: base,
        turnId: "receipt-replay",
        changedInodes: [{ inode: initial, paths: ["/initial"], removedPaths: [] }],
        signal: new AbortController().signal,
      });
      expect(original.status).toBe("ok");
      expect(commitCount).toBe(1);

      first.storage.release(initial);
      first.dispose();
      firstWakes.dispose();

      second = createFacetFilePersistence(database.storage, clock, { wakes: secondWakes, ports });
      const lazy = second.storage.create(second.storage.root, "lazy-after-reopen", {
        type: "file",
        exclusive: true,
      });
      second.storage.truncate(lazy, 1n);
      second.markUnhydrated({ inode: lazy, path: "/lazy-after-reopen", at: base, size: 1n });
      const replay = await second.commitTurn({
        at: base,
        turnId: "receipt-replay",
        changedInodes: [{ inode: lazy, paths: ["/lazy-after-reopen"], removedPaths: [] }],
        signal: new AbortController().signal,
      });

      expect(replay).toEqual(original);
      expect(fetchCount).toBe(0);
      expect(commitCount).toBe(1);
      second.storage.release(lazy);
    } finally {
      second?.dispose();
      secondWakes.dispose();
      first.dispose();
      firstWakes.dispose();
      database.close();
    }
  });
  it("cancels a commit waiting on shared hydration without cancelling its reader", async () => {
    const memory = createMemoryFilePersistencePorts();
    memory.seedFile(base, "/lazy", new Uint8Array([7]));
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fixture = rig({
      commits: memory.commits,
      hydration: {
        async fetch(input) {
          await gate;
          return memory.hydration.fetch(input);
        },
      },
    });
    try {
      const fs = fixture.persistence.storage;
      const inode = fs.create(fs.root, "lazy", { type: "file", exclusive: true });
      fs.truncate(inode, 1n);
      fixture.persistence.markUnhydrated({ inode, path: "/lazy", at: base, size: 1n });
      const reader = readAttempt(fixture.persistence, inode, 1);
      const cancellation = new AbortController();
      const commit = fixture.persistence.commitTurn({
        at: base,
        turnId: "cancelled",
        changedInodes: [{ inode, paths: ["/lazy"], removedPaths: [] }],
        signal: cancellation.signal,
      });
      cancellation.abort();
      expect(await commit).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
      expect(memory.committedTurns).toHaveLength(0);
      releaseFetch();
      await wake(reader, fixture.wakes);
      expect(readAttempt(fixture.persistence, inode, 1)).toEqual({
        status: "ok",
        value: new Uint8Array([7]),
      });
    } finally {
      releaseFetch();
      fixture.close();
    }
  });

  it("shares one fetch across readers and guards every content mutation until it finishes", async () => {
    const memory = createMemoryFilePersistencePorts();
    memory.seedFile(base, "/shared", new Uint8Array([7, 8]));
    const fixture = rig(memory);
    try {
      const fs = fixture.persistence.storage;
      const inode = fs.create(fs.root, "shared", { type: "file", exclusive: true });
      fs.truncate(inode, 2n);
      fixture.persistence.markUnhydrated({ inode, path: "/shared", at: base, size: 2n });
      for (const mutate of [
        () => fs.write(inode, 0n, new Uint8Array([1])),
        () => fs.append(inode, new Uint8Array([1])),
        () => fs.truncate(inode, 0n),
      ]) {
        expect(mutate).toThrow(expect.objectContaining({ code: "EAGAIN" }));
      }
      const one = readAttempt(fixture.persistence, inode, 2);
      const two = readAttempt(fixture.persistence, inode, 2);
      await Promise.all([wake(one, fixture.wakes), wake(two, fixture.wakes)]);
      expect(memory.fetchCalls).toHaveLength(1);
      expect(readAttempt(fixture.persistence, inode, 2)).toEqual({
        status: "ok",
        value: new Uint8Array([7, 8]),
      });
      expect(fixture.wakes.size).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
