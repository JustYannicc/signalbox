// @effect-diagnostics nodeBuiltinImport:off - validates the streamed pack with real Git.
import * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DriveDirectory } from "./DriveDirectory.ts";
import { makeDriveReader } from "./DriveReader.ts";
import { threadRef } from "./DriveStore.ts";
import { concatBytes, makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import { GITHUB_LIMITS, packForPush } from "./gitPush.ts";
import { packResponse } from "./routeResponses.ts";

const SOURCE = "folder/org_test/source";
const TARGET = "folder/org_test/target";
const owner = { userId: "owner", email: "owner@example.com", name: "Owner" };
const reader = { userId: "reader", email: "reader@example.com", name: "Reader" };
const writer = (userId: string, threadId: string) => ({
  userId,
  threadId,
  generation: 1,
  live: true,
  packsAfter: 0,
});
const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const git = makeRepo();
  repos.push(git);
  return git;
};
afterEach(() => {
  for (const git of repos.splice(0)) git.cleanup();
});

describe("shared drive history", () => {
  it.effect("rolls back an incomplete transfer and accepts a complete retry", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const directory = yield* DriveDirectory;
      const source = directory.forDrive(SOURCE);
      const target = directory.forDrive(TARGET);
      yield* source.setup({ name: "Original", members: [{ ...owner, role: "owner" }] });
      yield* target.setup({ name: "Alternative", members: [{ ...reader, role: "owner" }] });
      const history = yield* source.history(owner.userId);
      if (history._tag !== "ok") throw new Error("History unavailable.");
      const incomplete = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              '{"_tag":"pack","row":{"seq":1,"name":"incomplete","size":32,"object_count":0,"storage_drive_id":"source"}}\n',
            ),
          );
          controller.close();
        },
      });
      expect(
        (yield* target
          .startFromHistory(reader.userId, { ...history.history, data: incomplete })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(yield* target.packStorage("incomplete")).toBeNull();
      expect((yield* target.refs(null)).packs).toEqual([]);
      expect((yield* target.startFromHistory(reader.userId, history.history))._tag).toBe("ok");
      expect(yield* target.packStorage("incomplete")).toBeNull();
      expect((yield* target.refs(null)).packs.map(({ name }) => name)).not.toContain("incomplete");
    }).pipe(Effect.provide(drives.layer));
  });

  it.effect("keeps the captured head when the source advances during a paged transfer", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const directory = yield* DriveDirectory;
      const source = directory.forDrive(SOURCE);
      const target = directory.forDrive(TARGET);
      yield* source.setup({ name: "Original", members: [{ ...owner, role: "owner" }] });
      yield* target.setup({ name: "Alternative", members: [{ ...reader, role: "owner" }] });
      const git = repo();
      const commits: Array<string> = [];
      for (let i = 0; i < 12; i++) {
        git.write("file.txt", `version ${i}\n`);
        commits.push(git.commit(`version ${i}`));
      }
      const head = commits.at(-1)!;
      yield* uploadPack({ driveId: SOURCE, threadId: "seed", ...git.pack([head]) });
      yield* source.replaceMain(owner.userId, { expectedMain: null, newMain: head });
      const history = yield* source.history(owner.userId);
      if (history._tag !== "ok") throw new Error("History unavailable.");
      git.write("file.txt", "later\n");
      const later = git.commit("later");
      yield* uploadPack({ driveId: SOURCE, threadId: "later", ...git.pack([later], [head]) });
      yield* source.replaceMain(owner.userId, { expectedMain: head, newMain: later });
      yield* target.startFromHistory(reader.userId, history.history);
      expect(yield* target.ref("main")).toBe(head);
      expect((yield* target.log(head, 100)).map(({ oid }) => oid).toSorted()).toEqual(
        commits.toSorted(),
      );
      expect(yield* target.missing([later], null)).toEqual([later]);
    }).pipe(Effect.provide(drives.layer));
  });

  it.effect("retains a repository as a content source while landing work on its own main", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const directory = yield* DriveDirectory;
      const source = directory.forDrive(SOURCE);
      const target = directory.forDrive(TARGET);
      yield* source.setup({ name: "Original", members: [{ ...owner, role: "owner" }] });
      yield* target.setup({ name: "Alternative", members: [{ ...reader, role: "owner" }] });
      yield* source.setRemote({
        provider: "github",
        repository: "example/original",
        defaultBranch: "main",
      });
      const git = repo();
      git.write("README.md", "original\n");
      const first = git.commit("original");
      yield* uploadPack({ driveId: SOURCE, threadId: "seed", ...git.pack([first]) });
      yield* source.replaceMain(owner.userId, { expectedMain: null, newMain: first });
      const history = yield* source.history(owner.userId);
      if (history._tag !== "ok") throw new Error("History unavailable.");
      yield* target.startFromHistory(reader.userId, history.history);
      expect(yield* target.remote()).toEqual({
        provider: "github",
        repository: "example/original",
        defaultBranch: "main",
        mode: "source",
      });
      yield* target.open(writer(reader.userId, "alternative"));
      git.write("README.md", "alternative\n");
      const second = git.commit("alternative");
      yield* uploadPack({
        driveId: TARGET,
        threadId: "alternative",
        ...git.pack([second], [first]),
      });
      yield* target.updateRefs(writer(reader.userId, "alternative"), [
        { name: threadRef("alternative"), old: first, new: second },
      ]);
      expect(
        (yield* target.mirror(writer(reader.userId, "alternative"), {
          expectedMain: first,
          newMain: second,
        }))._tag,
      ).toBe("refused");
      expect(
        (yield* target.reconcile(writer(reader.userId, "alternative"), {
          expectedMain: first,
          newMain: second,
        }))._tag,
      ).toBe("ok");
      expect(yield* target.ref("main")).toBe(second);
      expect(yield* source.ref("main")).toBe(first);
    }).pipe(Effect.provide(drives.layer));
  });

  it.effect("starts a reader's independent refs over the same immutable packs", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const directory = yield* DriveDirectory;
      const source = directory.forDrive(SOURCE);
      const target = directory.forDrive(TARGET);
      yield* source.setup({
        name: "Original",
        members: [
          { ...owner, role: "owner" },
          { ...reader, role: "viewer" },
        ],
      });
      yield* target.setup({ name: "Alternative", members: [{ ...reader, role: "owner" }] });
      const git = repo();
      git.write("README.md", "first\n");
      const first = git.commit("first");
      git.write("README.md", "second\n");
      const second = git.commit("second");
      const packed = git.pack([second]);
      yield* uploadPack({ driveId: SOURCE, threadId: "seed", ...packed });
      expect(
        (yield* source.replaceMain(owner.userId, { expectedMain: null, newMain: second }))._tag,
      ).toBe("ok");
      const before = yield* source.refs(null);
      const keys = drives.bucket.keys();
      const history = yield* source.history(reader.userId);
      if (history._tag !== "ok") throw new Error("Reader could not read history.");
      expect(history.history.head).toBe(second);
      expect(yield* target.startFromHistory(reader.userId, history.history)).toEqual({
        _tag: "ok",
        sourceDriveId: SOURCE,
        head: second,
      });
      expect(drives.bucket.keys()).toEqual(keys);
      expect(yield* source.refs(null)).toEqual(before);
      expect(yield* target.ref("main")).toBe(second);
      expect((yield* target.log(second, 10)).map(({ oid }) => oid)).toEqual(
        expect.arrayContaining([first, second]),
      );
      const files = yield* makeDriveReader(TARGET);
      expect(yield* files.commit(first)).toMatchObject({ message: "first\n" });
      const contents = yield* files.entryAt((yield* files.commit(second)).tree, ["README.md"]);
      expect(new TextDecoder().decode(yield* files.blob(contents!.oid))).toBe("second\n");
      const download = yield* packResponse(TARGET, `${packed.name}.pack`);
      expect(download.status).toBe(200);
      expect(new Uint8Array(yield* Effect.promise(() => download.arrayBuffer()))).toEqual(
        packed.pack,
      );

      yield* target.open(writer(reader.userId, "new-work"));
      git.write("README.md", "alternative\n");
      const third = git.commit("alternative");
      yield* uploadPack({ driveId: TARGET, threadId: "new-work", ...git.pack([third], [second]) });
      expect(
        (yield* target.updateRefs(writer(reader.userId, "new-work"), [
          { name: threadRef("new-work"), old: second, new: third },
        ]))._tag,
      ).toBe("ok");
      expect(
        (yield* target.reconcile(writer(reader.userId, "new-work"), {
          expectedMain: second,
          newMain: third,
        }))._tag,
      ).toBe("ok");
      expect(yield* source.refs(null)).toEqual(before);
      const push = yield* packForPush({
        driveId: TARGET,
        head: third,
        old: null,
        remoteHas: [],
        limits: GITHUB_LIMITS,
      });
      const bytes = concatBytes(yield* Stream.runCollect(push.pack));
      const hash = NodeChildProcess.execFileSync("git", ["index-pack", "--stdin"], {
        cwd: git.dir,
        input: bytes,
        encoding: "utf8",
      })
        .trim()
        .split(/\s/u)
        .at(-1)!;
      expect(git.git(["verify-pack", "-v", `.git/objects/pack/pack-${hash}.idx`])).toContain(first);
      // A replay cannot rewind the destination after new work has landed.
      expect((yield* target.startFromHistory(reader.userId, history.history))._tag).toBe("ok");
      expect(yield* target.ref("main")).toBe(third);
      expect(yield* target.historyOrigin(reader.userId)).toEqual({
        sourceDriveId: SOURCE,
        head: second,
      });
      expect(yield* target.historyOrigin("stranger")).toBeNull();
      const next = directory.forDrive("folder/org_test/next");
      yield* next.setup({ name: "Next", members: [{ ...reader, role: "owner" }] });
      const nextHistory = yield* target.history(reader.userId);
      if (nextHistory._tag !== "ok") throw new Error("History disappeared.");
      yield* next.startFromHistory(reader.userId, nextHistory.history);
      expect(yield* next.packStorage(packed.name)).toBe(SOURCE);
      expect(
        new TextDecoder().decode(
          yield* (yield* makeDriveReader("folder/org_test/next")).blob(contents!.oid),
        ),
      ).toBe("second\n");
    }).pipe(Effect.provide(drives.layer));
  });

  it.effect(
    "checks source reading and destination ownership without exposing private machine packs",
    () => {
      const drives = makeMemoryDrives();
      return Effect.gen(function* () {
        const directory = yield* DriveDirectory;
        const source = directory.forDrive(SOURCE);
        const target = directory.forDrive(TARGET);
        yield* source.setup({
          name: "Original",
          members: [
            { ...owner, role: "owner" },
            { ...reader, role: "viewer" },
          ],
        });
        yield* target.setup({ name: "Alternative", members: [{ ...reader, role: "owner" }] });
        const git = repo();
        git.write("private.txt", "machine state\n");
        const privateHead = git.commit("private");
        yield* uploadPack({
          driveId: SOURCE,
          threadId: "machine",
          ...git.pack([privateHead]),
          private: true,
        });
        expect((yield* source.history("stranger"))._tag).toBe("refused");
        const history = yield* source.history(reader.userId);
        if (history._tag !== "ok") throw new Error("Reader could not read history.");
        expect((yield* target.startFromHistory(owner.userId, history.history))._tag).toBe(
          "refused",
        );
        expect((yield* target.startFromHistory(reader.userId, history.history))._tag).toBe("ok");
        expect(yield* target.missing([privateHead], null)).toEqual([privateHead]);
        const revoked = yield* source.unshare(owner, reader.userId);
        expect(revoked._tag).toBe("ok");
        expect((yield* source.history(reader.userId))._tag).toBe("refused");
      }).pipe(Effect.provide(drives.layer));
    },
  );
});
