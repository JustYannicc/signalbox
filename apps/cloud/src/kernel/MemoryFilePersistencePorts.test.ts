import { describe, expect, it } from "vite-plus/test";
import type { CommitInode, ForkCommit } from "./FilePersistencePorts.ts";
import { createMemoryFilePersistencePorts } from "./MemoryFilePersistencePorts.ts";
import type { Stat } from "./storage.ts";

const base: ForkCommit = { repository: "repo", fork: "alice", commit: "fork-1" };
const noChunks: CommitInode["readChunks"] = async function* () {
  yield* [];
};

const stat = (type: Stat["type"], size: bigint): Stat => ({
  type,
  size,
  nlink: 1n,
  atimeNs: 1n,
  mtimeNs: 2n,
  ctimeNs: 3n,
});

const changed = (
  inode: bigint,
  paths: readonly string[],
  removedPaths: readonly string[],
  fileStat: Readonly<Stat> | null,
  readChunks: CommitInode["readChunks"],
  symlinkTarget: string | null = null,
): CommitInode => ({ inode, paths, removedPaths, stat: fileStat, readChunks, symlinkTarget });

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of chunks) {
    parts.push(part);
    size += part.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("memory file persistence ports", () => {
  it("hydrates only requested files from the exact fork and commit in owned 64 KiB chunks", async () => {
    const ports = createMemoryFilePersistencePorts();
    const otherFork = { ...base, fork: "bob" };
    const source = new Uint8Array(64 * 1024 + 3).fill(7);
    ports.seedFile(base, "wanted", source);
    ports.seedFile(base, "unrequested", new Uint8Array([4]));
    ports.seedFile(otherFork, "wanted", new Uint8Array([9]));
    source.fill(0);

    const result = await ports.hydration.fetch({
      at: base,
      paths: ["wanted"],
      signal: new AbortController().signal,
    });
    if (result.status !== "ok") throw new Error(result.error.message);
    expect(result.value.map((file) => file.path)).toEqual(["wanted"]);
    const fetchedChunks: Uint8Array[] = [];
    for await (const chunk of result.value[0]!.chunks) fetchedChunks.push(chunk);
    expect(fetchedChunks.map((chunk) => chunk.byteLength)).toEqual([64 * 1024, 3]);
    fetchedChunks[0]!.fill(0);

    const reread = await ports.hydration.fetch({
      at: base,
      paths: ["wanted"],
      signal: new AbortController().signal,
    });
    if (reread.status !== "ok") throw new Error(reread.error.message);
    expect(await readAll(reread.value[0]!.chunks)).toEqual(new Uint8Array(64 * 1024 + 3).fill(7));

    const isolated = await ports.hydration.fetch({
      at: otherFork,
      paths: ["wanted"],
      signal: new AbortController().signal,
    });
    if (isolated.status !== "ok") throw new Error(isolated.error.message);
    expect(await readAll(isolated.value[0]!.chunks)).toEqual(new Uint8Array([9]));
    expect(ports.fetchCalls[0]).toMatchObject({ at: base, paths: ["wanted"], status: "ok" });

    const missing = await ports.hydration.fetch({
      at: { ...base, commit: "missing" },
      paths: ["wanted"],
      signal: new AbortController().signal,
    });
    expect(missing).toMatchObject({ status: "error", error: { code: "NOT_FOUND" } });
    const controller = new AbortController();
    controller.abort();
    const canceled = await ports.hydration.fetch({
      at: base,
      paths: ["wanted"],
      signal: controller.signal,
    });
    expect(canceled).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
  });

  it("applies renames, deletions, directories, and symlinks while preserving other files", async () => {
    const ports = createMemoryFilePersistencePorts();
    ports.seedFile(base, "old-name", new Uint8Array([1, 2]));
    ports.seedFile(base, "keep", new Uint8Array([3]));
    ports.seedFile(base, "deleted", new Uint8Array([4]));
    let directoryReadCount = 0;

    const receipt = await ports.commits.commit({
      at: base,
      turnId: "turn-rename",
      changedInodes: [
        changed(1n, ["new-name"], ["old-name"], stat("file", 2n), async function* () {
          yield new Uint8Array([8, 9]);
        }),
        changed(2n, ["folder"], [], stat("directory", 0n), () => {
          directoryReadCount++;
          return noChunks();
        }),
        changed(3n, ["shortcut"], [], stat("symlink", 4n), noChunks, "keep"),
        changed(4n, ["deleted"], [], null, noChunks),
      ],
      signal: new AbortController().signal,
    });
    if (receipt.status !== "ok") throw new Error(receipt.error.message);

    const committedAt = { ...base, commit: receipt.value.commit };
    const tree = ports.inspectTree(committedAt)!;
    expect(tree["new-name"]!.data).toEqual(new Uint8Array([8, 9]));
    expect(tree["old-name"]).toBeUndefined();
    expect(tree["keep"]!.data).toEqual(new Uint8Array([3]));
    expect(tree["deleted"]).toBeUndefined();
    expect(tree["folder"]!.stat.type).toBe("directory");
    expect(tree["shortcut"]).toMatchObject({ stat: { type: "symlink" }, symlinkTarget: "keep" });
    expect(directoryReadCount).toBe(0);
    expect(ports.committedTurns[0]!.tree).toEqual(tree);
  });

  it("replays a turn receipt without reading again and rejects a different stale turn", async () => {
    const ports = createMemoryFilePersistencePorts();
    ports.seedFile(base, "file", new Uint8Array([1]));
    let reads = 0;
    const first = changed(1n, ["file"], [], stat("file", 1n), async function* () {
      reads++;
      yield new Uint8Array([2]);
    });
    const firstReceipt = await ports.commits.commit({
      at: base,
      turnId: "same-turn",
      changedInodes: [first],
      signal: new AbortController().signal,
    });
    if (firstReceipt.status !== "ok") throw new Error(firstReceipt.error.message);

    const replay = await ports.commits.commit({
      at: base,
      turnId: "same-turn",
      changedInodes: [
        changed(2n, ["ignored"], [], stat("file", 1n), async function* () {
          throw new Error("idempotent replay must not read");
        }),
      ],
      signal: new AbortController().signal,
    });
    expect(replay).toEqual(firstReceipt);
    expect(reads).toBe(1);

    const stale = await ports.commits.commit({
      at: base,
      turnId: "different-turn",
      changedInodes: [],
      signal: new AbortController().signal,
    });
    expect(stale).toMatchObject({ status: "error", error: { code: "STALE_COMMIT" } });
    expect(ports.committedTurns).toHaveLength(1);
  });

  it("allows only one concurrent turn to advance the same fork head", async () => {
    const ports = createMemoryFilePersistencePorts();
    ports.seedFile(base, "kept", new Uint8Array([1]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startCommit = (turnId: string, path: string, value: number) =>
      ports.commits.commit({
        at: base,
        turnId,
        changedInodes: [
          changed(BigInt(value), [path], [], stat("file", 1n), async function* () {
            await gate;
            yield new Uint8Array([value]);
          }),
        ],
        signal: new AbortController().signal,
      });
    const first = startCommit("turn-a", "first", 2);
    const second = startCommit("turn-b", "second", 3);
    release();
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.status === "error")).toMatchObject([
      { status: "error", error: { code: "STALE_COMMIT" } },
    ]);
    const success = results.find((result) => result.status === "ok");
    if (success?.status !== "ok") throw new Error("One concurrent commit should succeed");
    expect(ports.committedTurns).toHaveLength(1);

    const tree = ports.inspectTree({ ...base, commit: success.value.commit })!;
    expect(tree["kept"]!.data).toEqual(new Uint8Array([1]));
    expect(tree["first"] !== undefined).not.toBe(tree["second"] !== undefined);
  });

  it("keeps a renamed inode at an overwritten destination regardless of deleted-inode order", async () => {
    const ports = createMemoryFilePersistencePorts();
    ports.seedFile(base, "source", new Uint8Array([1]));
    ports.seedFile(base, "destination", new Uint8Array([2]));
    const result = await ports.commits.commit({
      at: base,
      turnId: "overwrite-destination",
      changedInodes: [
        changed(1n, ["destination"], ["source"], stat("file", 1n), async function* () {
          yield new Uint8Array([7]);
        }),
        changed(2n, [], ["destination"], null, noChunks),
      ],
      signal: new AbortController().signal,
    });
    if (result.status !== "ok") throw new Error(result.error.message);
    const tree = ports.inspectTree({ ...base, commit: result.value.commit })!;
    expect(tree["source"]).toBeUndefined();
    expect(tree["destination"]!.data).toEqual(new Uint8Array([7]));
  });

  it("keeps a generated-looking seed commit immutable and stale after advancing the head", async () => {
    const ports = createMemoryFilePersistencePorts();
    const seededAt = { ...base, commit: "memory-commit-1" };
    ports.seedFile(seededAt, "original", new Uint8Array([1]));
    const first = await ports.commits.commit({
      at: seededAt,
      turnId: "advance-generated-looking-base",
      changedInodes: [
        changed(1n, ["added"], [], stat("file", 1n), async function* () {
          yield new Uint8Array([2]);
        }),
      ],
      signal: new AbortController().signal,
    });
    if (first.status !== "ok") throw new Error(first.error.message);

    expect(first.value.commit).not.toBe(seededAt.commit);
    expect(ports.inspectTree(seededAt)?.["original"]!.data).toEqual(new Uint8Array([1]));
    expect(ports.inspectTree({ ...seededAt, commit: first.value.commit })?.["added"]!.data).toEqual(
      new Uint8Array([2]),
    );

    const stale = await ports.commits.commit({
      at: seededAt,
      turnId: "old-base-retry",
      changedInodes: [],
      signal: new AbortController().signal,
    });
    expect(stale).toMatchObject({ status: "error", error: { code: "STALE_COMMIT" } });
    expect(ports.inspectTree(seededAt)?.["original"]!.data).toEqual(new Uint8Array([1]));
  });

  it("keeps failed and aborted commits atomic and checks file length against stat", async () => {
    const ports = createMemoryFilePersistencePorts();
    ports.seedFile(base, "base-file", new Uint8Array([1]));

    const failed = await ports.commits.commit({
      at: base,
      turnId: "bad-size",
      changedInodes: [
        changed(1n, ["would-be-written"], [], stat("file", 1n), async function* () {
          yield new Uint8Array([2]);
        }),
        changed(2n, ["wrong-size"], [], stat("file", 2n), async function* () {
          yield new Uint8Array([3]);
        }),
      ],
      signal: new AbortController().signal,
    });
    expect(failed).toMatchObject({ status: "error", error: { code: "IO_ERROR" } });
    expect(ports.inspectTree(base)).toMatchObject({ "base-file": { data: new Uint8Array([1]) } });
    expect(ports.inspectTree(base)?.["would-be-written"]).toBeUndefined();
    expect(ports.committedTurns).toHaveLength(0);

    const controller = new AbortController();
    const aborted = await ports.commits.commit({
      at: base,
      turnId: "aborted",
      changedInodes: [
        changed(3n, ["aborted-file"], [], stat("file", 1n), async function* () {
          controller.abort();
          yield new Uint8Array([7]);
        }),
      ],
      signal: controller.signal,
    });
    expect(aborted).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
    expect(ports.inspectTree(base)?.["aborted-file"]).toBeUndefined();
    expect(ports.committedTurns).toHaveLength(0);
  });
});
