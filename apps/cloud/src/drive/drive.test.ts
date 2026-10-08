import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DriveDirectory } from "./DriveDirectory.ts";
import * as DriveFiles from "./DriveFiles.ts";
import { makeDriveReader } from "./DriveReader.ts";
import { MAIN_REF, threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import { verifyPack } from "./git/gitPack.ts";

const DRIVE = "my/personal/user_1";
const writer = (threadId: string, generation = 1, live = true) => ({
  threadId,
  userId: "user_1",
  generation,
  live,
  packsAfter: 0,
});

const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const created = makeRepo();
  repos.push(created);
  return created;
};
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const drive = (drives: ReturnType<typeof makeMemoryDrives>) =>
  DriveDirectory.use((directory) => Effect.succeed(directory.forDrive(DRIVE))).pipe(
    Effect.provide(drives.layer),
  );

const upload = (
  drives: ReturnType<typeof makeMemoryDrives>,
  packed: { readonly pack: Uint8Array<ArrayBuffer>; readonly idx: Uint8Array<ArrayBuffer> },
  threadId = "t1",
) =>
  uploadPack({ driveId: DRIVE, threadId, idx: packed.idx, pack: packed.pack }).pipe(
    Effect.provide(drives.layer),
  );

describe("packs", () => {
  it.effect("accepts a real pack with deltas and refuses a tampered one", () =>
    Effect.gen(function* () {
      const git = repo();
      // Two close versions of a big file make git store one as a delta.
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of a long file`);
      git.write("big.txt", lines.join("\n"));
      git.commit("one");
      git.write("big.txt", [...lines, "one more"].join("\n"));
      const head = git.commit("two");
      const packed = git.pack([head]);
      const verified = yield* Effect.promise(() => verifyPack(packed.pack, packed.idx));
      expect(verified.name).toBe(packed.name);
      expect(verified.objects.length).toBe(
        git.git(["rev-list", "--objects", head]).split("\n").length,
      );
      expect(verified.objects.some((object) => object.type === "blob")).toBe(true);
      expect(verified.external.size).toBe(0);

      const tampered = packed.pack.slice();
      tampered[40] = tampered[40]! ^ 0xff;
      const refused = yield* Effect.promise(() =>
        verifyPack(tampered, packed.idx).then(
          () => "accepted",
          (error: Error) => error.message,
        ),
      );
      expect(refused).toMatch(/checksum/);
    }),
  );

  it.effect("refuses a pack that leans on objects the drive lacks, until they arrive", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const git = repo();
      git.write("a.txt", "a\n");
      const first = git.commit("first");
      git.write("b.txt", "b\n");
      const second = git.commit("second");
      const later = git.pack([second], [first]);
      expect((yield* upload(drives, later))._tag).toBe("refused");
      // Nothing was stored, so no ref can name the second commit.
      const handle = yield* drive(drives);
      yield* handle.open(writer("t1"));
      const early = yield* handle.updateRefs(writer("t1"), [
        { name: wipRef("t1"), old: null, new: second },
      ]);
      expect(early._tag).toBe("refused");

      expect((yield* upload(drives, git.pack([first])))._tag).toBe("ok");
      expect((yield* upload(drives, later))._tag).toBe("ok");
      const moved = yield* handle.updateRefs(writer("t1"), [
        { name: wipRef("t1"), old: null, new: second },
      ]);
      expect(moved._tag).toBe("ok");
    }),
  );

  it.effect("a pack cut off mid-upload is refused and leaves nothing to point at", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const git = repo();
      git.write("a.txt", "a\n");
      const head = git.commit("first");
      const packed = git.pack([head]);
      const cut = { idx: packed.idx, pack: packed.pack.slice(0, packed.pack.length - 7) };
      expect((yield* upload(drives, cut))._tag).toBe("refused");
      expect(drives.bucket.keys()).toEqual([]);
      const handle = yield* drive(drives);
      yield* handle.open(writer("t1"));
      expect((yield* handle.missing([head])).length).toBe(1);
    }),
  );
});

describe("refs", () => {
  /** A drive holding `base` on main, with `t1` and `t2` opened on it. */
  const seeded = Effect.gen(function* () {
    const drives = makeMemoryDrives();
    const git = repo();
    git.write("a.txt", "a\n");
    const base = git.commit("base");
    yield* upload(drives, git.pack([base]));
    const handle = yield* drive(drives);
    yield* handle.open(writer("seed"));
    yield* handle.updateRefs(writer("seed"), [{ name: threadRef("seed"), old: null, new: base }]);
    expect(
      (yield* handle.reconcile(writer("seed"), { expectedMain: null, newMain: base }))._tag,
    ).toBe("ok");
    git.write("b.txt", "b\n");
    const next = git.commit("next");
    yield* upload(drives, git.pack([next], [base]));
    return { drives, git, handle, base, next };
  });

  it.effect("new threads start from main, with their base pinned", () =>
    Effect.gen(function* () {
      const { handle, base } = yield* seeded;
      const opened = yield* handle.open(writer("t1"));
      expect(opened._tag === "ok" && opened.refs).toMatchObject({ main: base, thread: base, base });
    }),
  );

  it.effect("a thread moves only its own refs, and main only through its own reconcile", () =>
    Effect.gen(function* () {
      const { handle, base, next } = yield* seeded;
      yield* handle.open(writer("t1"));
      yield* handle.open(writer("t2"));
      for (const name of [threadRef("t2"), wipRef("t2"), MAIN_REF, "anything"]) {
        const write = yield* handle.updateRefs(writer("t1"), [{ name, old: base, new: next }]);
        expect(write._tag).toBe("refused");
      }
      expect(yield* handle.ref(threadRef("t2"))).toBe(base);
      // main moves only to the thread's own branch...
      const notOwn = yield* handle.reconcile(writer("t1"), { expectedMain: base, newMain: next });
      expect(notOwn).toMatchObject({ _tag: "refused" });
      yield* handle.updateRefs(writer("t1"), [{ name: threadRef("t1"), old: base, new: next }]);
      // ...only while its turn runs...
      const idle = yield* handle.reconcile(writer("t1", 1, false), {
        expectedMain: base,
        newMain: next,
      });
      expect(idle).toMatchObject({ _tag: "refused" });
      // ...and then it lands.
      const landed = yield* handle.reconcile(writer("t1"), { expectedMain: base, newMain: next });
      expect(landed._tag).toBe("ok");
      expect(yield* handle.ref(MAIN_REF)).toBe(next);
    }),
  );

  it.effect("main only fast-forwards, and a moved main is a conflict to merge", () =>
    Effect.gen(function* () {
      const { drives, handle, git, base, next } = yield* seeded;
      yield* handle.open(writer("t1"));
      yield* handle.open(writer("t2"));
      yield* handle.updateRefs(writer("t1"), [{ name: threadRef("t1"), old: base, new: next }]);
      expect(
        (yield* handle.reconcile(writer("t1"), { expectedMain: base, newMain: next }))._tag,
      ).toBe("ok");
      // t2 worked from base, unaware of t1.
      git.git(["checkout", "-q", "-b", "other", base]);
      git.write("c.txt", "c\n");
      const other = git.commit("other");
      yield* upload(drives, git.pack([other], [base]), "t2");
      yield* handle.updateRefs(writer("t2"), [{ name: threadRef("t2"), old: base, new: other }]);
      const stale = yield* handle.reconcile(writer("t2"), { expectedMain: base, newMain: other });
      expect(stale._tag).toBe("conflict");
      const rewind = yield* handle.reconcile(writer("t2"), { expectedMain: next, newMain: other });
      expect(rewind).toMatchObject({ _tag: "refused" });
      // Merged, it lands, and main keeps both threads' work.
      git.git(["merge", "-q", "--no-edit", next]);
      const merged = git.git(["rev-parse", "HEAD"]);
      yield* upload(drives, git.pack([merged], [next, other]), "t2");
      yield* handle.updateRefs(writer("t2"), [{ name: threadRef("t2"), old: other, new: merged }]);
      const landed = yield* handle.reconcile(writer("t2"), { expectedMain: next, newMain: merged });
      expect(landed._tag).toBe("ok");
      expect(yield* handle.ref(MAIN_REF)).toBe(merged);
    }),
  );

  it.effect("an older machine of a thread writes nothing once a newer one has", () =>
    Effect.gen(function* () {
      const { handle, base, next } = yield* seeded;
      yield* handle.open(writer("t1", 1));
      yield* handle.open(writer("t1", 2));
      const stale = yield* handle.updateRefs(writer("t1", 1), [
        { name: wipRef("t1"), old: null, new: next },
      ]);
      expect(stale._tag).toBe("refused");
      const fresh = yield* handle.updateRefs(writer("t1", 2), [
        { name: wipRef("t1"), old: null, new: next },
      ]);
      expect(fresh._tag).toBe("ok");
      expect(base).not.toBe(next);
    }),
  );
});

describe("reading without a machine", () => {
  it.effect("lists, reads and searches main, and diffs turns like git does", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const git = repo();
      git.write("notes/plan.md", "# Plan\n\n- one\n- two\n");
      git.write("readme.txt", "hello\n");
      const first = git.commit("first");
      git.write("notes/plan.md", "# Plan\n\n- one\n- two\n- three\n");
      git.write("data.bin", "\u0000\u0001binary");
      git.git(["rm", "-q", "readme.txt"]);
      const second = git.commit("second");
      yield* upload(drives, git.pack([second]));
      const handle = yield* drive(drives);
      yield* handle.open(writer("t1"));
      yield* handle.updateRefs(writer("t1"), [{ name: threadRef("t1"), old: null, new: second }]);
      yield* handle.reconcile(writer("t1"), { expectedMain: null, newMain: second });

      const files = yield* DriveFiles.DriveFiles.use(Effect.succeed).pipe(
        Effect.provide(DriveFiles.layer.pipe(Layer.provide(drives.layer))),
      );
      expect(yield* files.listEntries(DRIVE, "")).toEqual([
        { path: "data.bin", kind: "file" },
        { path: "notes", kind: "directory" },
      ]);
      expect(yield* files.listEntries(DRIVE, "notes")).toEqual([
        { path: "notes/plan.md", kind: "file" },
      ]);
      expect(yield* files.readFile(DRIVE, "notes/plan.md")).toMatchObject({
        _tag: "file",
        contents: "# Plan\n\n- one\n- two\n- three\n",
      });
      expect((yield* files.readFile(DRIVE, "notes"))._tag).toBe("not_file");
      expect((yield* files.readFile(DRIVE, "data.bin"))._tag).toBe("binary");
      expect((yield* files.readFile(DRIVE, "../escape"))._tag).toBe("outside");
      const search = yield* files.searchEntries(DRIVE, { query: "plan", limit: 10 });
      expect(search.entries.map((entry) => entry.path)).toEqual(["notes/plan.md"]);

      const reader = yield* makeDriveReader(DRIVE).pipe(Effect.provide(drives.layer));
      const ours = yield* reader.diff(first, second, { ignoreWhitespace: false });
      const theirs = git.git([
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        first,
        second,
      ]);
      expect(ours.trim()).toBe(theirs.trim());
    }),
  );

  it.effect("reads deltas whose base an earlier pack already holds", () =>
    Effect.gen(function* () {
      const drives = makeMemoryDrives();
      const git = repo();
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of a long file`);
      // git deltas smaller blobs against bigger ones, so the bigger one goes first.
      git.write("big.txt", [...lines, "one more"].join("\n"));
      const first = git.commit("one");
      git.write("big.txt", lines.join("\n"));
      const second = git.commit("two");
      yield* upload(drives, git.pack([first]));
      // Packed without excluding the first: its blob is in both packs, the delta base in the second.
      const both = git.pack([second]);
      yield* upload(drives, both);
      const reader = yield* makeDriveReader(DRIVE).pipe(Effect.provide(drives.layer));
      const diff = yield* reader.diff(first, second, { ignoreWhitespace: false });
      expect(diff).toContain("-one more");
    }),
  );
});
