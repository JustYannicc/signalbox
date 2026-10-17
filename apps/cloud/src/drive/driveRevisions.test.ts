// @effect-diagnostics nodeBuiltinImport:off - the test inspects a real Git push pack.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeDriveReader } from "./DriveReader.ts";
import { GITHUB_LIMITS, packForPush } from "./gitPush.ts";
import { concatBytes } from "./git/gitObjects.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import { threadRef, wipRef } from "./DriveStore.ts";
import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";

const DRIVE = "my/personal/user_1";
const writer = (threadId: string, generation = 1) => ({
  threadId,
  userId: "user_1",
  generation,
  live: true,
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

const upload = (
  drives: ReturnType<typeof makeMemoryDrives>,
  packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>,
  threadId = "t1",
) =>
  uploadPack({ driveId: DRIVE, threadId, idx: packed.idx, pack: packed.pack }).pipe(
    Effect.provide(drives.layer),
  );

const views: DriveCheckpointRecord["views"] = {
  shortcuts: [{ path: "docs", target: "my/personal/docs", commit: null }],
  context: {
    driveId: DRIVE,
    contexts: [
      {
        contextId: "personal",
        name: "Personal",
        drives: [
          {
            driveId: DRIVE,
            path: null,
            commit: null,
            time: null,
            shortcuts: [{ path: "docs", target: "my/personal/docs" }],
          },
        ],
      },
    ],
  },
};

describe("drive checkpoints and revisions", () => {
  it.effect(
    "retains immutable checkpoints, forks/restores by ref, and never pushes Git notes",
    () =>
      Effect.gen(function* () {
        const drives = makeMemoryDrives();
        const git = repo();
        git.write("README.md", "first\n");
        const first = git.commit("first");
        yield* upload(drives, git.pack([first]));

        const handle = yield* DriveDirectory.use((directory) =>
          Effect.succeed(directory.forDrive(DRIVE)),
        ).pipe(Effect.provide(drives.layer));
        yield* handle.open(writer("seed"));
        expect(
          (yield* handle.updateRefs(writer("seed"), [
            { name: threadRef("seed"), old: null, new: first },
          ]))._tag,
        ).toBe("ok");
        expect(
          (yield* handle.reconcile(writer("seed"), { expectedMain: null, newMain: first }))._tag,
        ).toBe("ok");
        yield* handle.open(writer("t1"));

        git.write("README.md", "second\n");
        const second = git.commit("second");
        git.git(["notes", "--ref=signalbox/checkpoints", "add", "-m", "private trace", second]);
        const notes = git.git(["rev-parse", "refs/notes/signalbox/checkpoints"]);
        const noteTree = git.git(["show", "-s", "--format=%T", notes]);
        const noteBlob = git.git(["ls-tree", "-r", notes]).split(" ")[2]!.split("\t")[0]!;
        yield* upload(drives, git.pack([second, notes], [first]));
        expect(
          (yield* handle.updateRefs(writer("t1"), [
            { name: threadRef("t1"), old: first, new: second },
            { name: wipRef("t1"), old: null, new: second },
          ]))._tag,
        ).toBe("ok");

        const record: DriveCheckpointRecord = {
          runId: "run-1",
          turnId: "turn-1",
          commit: second,
          start: first,
          notes,
          views,
        };
        expect((yield* handle.recordCheckpoint(writer("t1"), record))._tag).toBe("ok");
        expect(yield* handle.checkpoint("t1", "run-1")).toEqual(record);
        expect(yield* handle.ref("signalbox/checkpoints/t1/run-1")).toBeNull();
        expect(
          (yield* handle.recordCheckpoint(writer("t1"), { ...record, turnId: "changed" }))._tag,
        ).toBe("refused");
        const push = yield* packForPush({
          driveId: DRIVE,
          head: second,
          old: first,
          remoteHas: [first],
          limits: GITHUB_LIMITS,
        }).pipe(Effect.provide(drives.layer));
        const pushPack = concatBytes(yield* Stream.runCollect(push.pack));
        const pushHash = NodeChildProcess.execFileSync("git", ["index-pack", "--stdin"], {
          cwd: git.dir,
          input: pushPack,
          encoding: "utf8",
        })
          .trim()
          .split(/\s/u)
          .at(-1)!;
        const pushIndex = NodePath.join(git.dir, ".git", "objects", "pack", `pack-${pushHash}.idx`);
        const pushedObjects = git.git(["verify-pack", "-v", pushIndex]).split("\n");
        expect(pushedObjects.some((line) => line.startsWith(`${notes} `))).toBe(false);
        expect(pushedObjects.some((line) => line.startsWith(`${noteTree} `))).toBe(false);
        expect(pushedObjects.some((line) => line.startsWith(`${noteBlob} `))).toBe(false);

        git.write("README.md", "third\n");
        const third = git.commit("third");
        git.git(["notes", "--ref=signalbox/checkpoints", "add", "-m", "later trace", third]);
        const latestNotes = git.git(["rev-parse", "refs/notes/signalbox/checkpoints"]);
        yield* upload(drives, git.pack([third, latestNotes], [second, notes]));
        expect(
          (yield* handle.updateRefs(writer("t1"), [
            { name: threadRef("t1"), old: second, new: third },
            { name: wipRef("t1"), old: second, new: third },
          ]))._tag,
        ).toBe("ok");
        const laterRecord: DriveCheckpointRecord = {
          ...record,
          runId: "run-2",
          turnId: "turn-2",
          commit: third,
          start: second,
          notes: latestNotes,
        };
        expect((yield* handle.recordCheckpoint(writer("t1"), laterRecord))._tag).toBe("ok");

        const beforeFork = (yield* handle.refs(null)).packs.map((pack) => pack.name);
        const objectsBeforeFork = (yield* handle.locate([first, second, third, notes, latestNotes]))
          .map((object) => object.oid)
          .toSorted();
        const forked = yield* handle.forkCheckpoint("user_1", {
          sourceThreadId: "t1",
          runId: "run-1",
          threadId: "child",
          operationId: "fork-1",
        });
        expect(forked).toMatchObject({
          _tag: "ok",
          generation: 0,
          refs: {
            thread: second,
            wip: second,
            base: second,
            machine: null,
            notes: latestNotes,
            pinnedViews: views,
            revision: "fork-1",
          },
        });
        if (forked._tag !== "ok") throw new Error("The checkpoint fork was refused.");
        if (forked.refs.thread === null) throw new Error("The checkpoint fork has no branch.");
        expect((yield* handle.refs(null)).packs.map((pack) => pack.name)).toEqual(beforeFork);
        expect(
          (yield* handle.locate([first, second, third, notes, latestNotes]))
            .map((object) => object.oid)
            .toSorted(),
        ).toEqual(objectsBeforeFork);
        const childReader = yield* makeDriveReader(DRIVE).pipe(Effect.provide(drives.layer));
        expect(
          yield* childReader.diff(null, forked.refs.thread, { ignoreWhitespace: false }),
        ).toContain("+second");
        expect(
          (yield* handle.forkCheckpoint("user_1", {
            sourceThreadId: "t1",
            runId: "run-2",
            threadId: "child",
            operationId: "fork-1",
          }))._tag,
        ).toBe("refused");

        const sharedDrive = drives.apiFor("shared/work/revision-access");
        yield* Effect.promise(() =>
          sharedDrive.setup({
            name: "Revision access",
            members: [
              { userId: "manager", email: "manager@example.test", name: null, role: "manager" },
              { userId: "removed", email: "removed@example.test", name: null, role: "manager" },
            ],
          }),
        );
        expect(
          (yield* Effect.promise(() =>
            sharedDrive.unshare(
              {
                userId: "removed",
                email: "removed@example.test",
                name: null,
              },
              "removed",
            ),
          ))._tag,
        ).toBe("ok");
        expect(
          (yield* Effect.promise(() =>
            sharedDrive.forkCheckpoint("removed", {
              sourceThreadId: "missing",
              runId: "missing",
              threadId: "revoked-child",
              operationId: "revoked-fork",
            }),
          ))._tag,
        ).toBe("refused");

        const beforeRestore = (yield* handle.refs(null)).packs.map((pack) => pack.name);
        const objectsBeforeRestore = (yield* handle.locate([
          first,
          second,
          third,
          notes,
          latestNotes,
        ]))
          .map((object) => object.oid)
          .toSorted();
        const restored = yield* handle.restoreCheckpoint("user_1", {
          threadId: "t1",
          runId: "run-1",
          operationId: "restore-1",
          expectedThread: third,
          expectedWip: third,
          generation: 1,
        });
        expect(restored).toMatchObject({
          _tag: "ok",
          generation: 2,
          refs: {
            thread: second,
            wip: second,
            notes: latestNotes,
            pinnedViews: views,
            revision: "restore-1",
          },
        });
        expect((yield* handle.refs(null)).packs.map((pack) => pack.name)).toEqual(beforeRestore);
        expect(
          (yield* handle.locate([first, second, third, notes, latestNotes]))
            .map((object) => object.oid)
            .toSorted(),
        ).toEqual(objectsBeforeRestore);
        expect(
          (yield* handle.updateRefs(writer("t1"), [
            { name: wipRef("t1"), old: second, new: third },
          ]))._tag,
        ).toBe("refused");
        expect((yield* handle.recordCheckpoint(writer("t1"), laterRecord))._tag).toBe("refused");
        expect(
          (yield* handle.updateToLatest("user_1", {
            threadId: "t1",
            operationId: "stale-latest",
            expectedThread: second,
            expectedWip: second,
            generation: 1,
          }))._tag,
        ).toBe("refused");

        expect(
          (yield* handle.updateRefs(writer("t1", 2), [
            { name: wipRef("t1"), old: second, new: third },
          ]))._tag,
        ).toBe("ok");
        const retry = yield* handle.restoreCheckpoint("user_1", {
          threadId: "t1",
          runId: "run-1",
          operationId: "restore-1",
          expectedThread: third,
          expectedWip: third,
          generation: 1,
        });
        expect(retry).toMatchObject({ _tag: "ok", generation: 2, refs: { wip: third } });

        const undo = yield* handle.restoreCheckpoint("user_1", {
          threadId: "t1",
          runId: "run-2",
          operationId: "undo-restore-2",
          expectedThread: second,
          expectedWip: third,
          generation: 2,
        });
        expect(undo).toMatchObject({
          _tag: "ok",
          generation: 3,
          refs: { thread: third, wip: third, notes: latestNotes },
        });
        expect(yield* handle.checkpoint("t1", "run-2")).toEqual(laterRecord);

        const current = yield* handle.refs("child");
        const updated = yield* handle.updateToLatest("user_1", {
          threadId: "child",
          operationId: "latest-1",
          expectedThread: current.thread,
          expectedWip: current.wip,
          generation: 0,
        });
        expect(updated).toMatchObject({
          _tag: "ok",
          generation: 1,
          refs: { pinnedViews: null, revision: "latest-1" },
        });
        expect(
          (yield* handle.updateRefs(writer("child", 0), [
            { name: wipRef("child"), old: second, new: third },
          ]))._tag,
        ).toBe("refused");
      }),
  );
});
