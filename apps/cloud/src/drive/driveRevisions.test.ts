// @effect-diagnostics nodeBuiltinImport:off - the test inspects a real Git push pack.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { makeDriveReader } from "./DriveReader.ts";
import { GITHUB_LIMITS, packForPush } from "./gitPush.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import * as DriveRevisions from "./DriveRevisions.ts";
import * as DriveEvents from "./DriveEvents.ts";
import { concatBytes, registerPack, makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";
import * as DriveStore from "./DriveStore.ts";
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

        const restoredLaterCheckpoint = yield* handle.restoreCheckpoint("user_1", {
          threadId: "t1",
          runId: "run-2",
          operationId: "restore-run-2",
          expectedThread: second,
          expectedWip: third,
          generation: 2,
        });
        expect(restoredLaterCheckpoint).toMatchObject({
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

  it.effect("undoes a restore without losing a distinct autosave head or newer work", () => {
    const layer = DriveStore.layer(DRIVE).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
    return Effect.gen(function* () {
      const store = yield* DriveStore.DriveStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.initialize;
      const handle = store;
      const undoRestore = store.undoRestore;
      const storedRef = (name: string) =>
        sql<{ readonly oid: string }>`SELECT oid FROM refs WHERE name = ${name}`.pipe(
          Effect.map((rows) => rows[0]?.oid ?? null),
        );
      const git = repo();
      const uploadDirect = (packed: ReturnType<ReturnType<typeof makeRepo>["pack"]>) =>
        registerPack("t1", packed);

      git.write("README.md", "first\n");
      const first = git.commit("first");
      expect((yield* uploadDirect(git.pack([first])))._tag).toBe("ok");
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
      expect((yield* uploadDirect(git.pack([second], [first])))._tag).toBe("ok");
      git.write("README.md", "third\n");
      const third = git.commit("third");
      expect((yield* uploadDirect(git.pack([third], [second])))._tag).toBe("ok");
      expect(
        (yield* handle.updateRefs(writer("t1"), [
          { name: threadRef("t1"), old: first, new: second },
          { name: wipRef("t1"), old: null, new: third },
        ]))._tag,
      ).toBe("ok");

      const priorViews: DriveCheckpointRecord["views"] = {
        ...views,
        shortcuts: [{ path: "notes", target: "my/personal/notes", commit: null }],
      };
      const checkpoint = (
        runId: string,
        commit: string,
        checkpointViews: DriveCheckpointRecord["views"],
      ): DriveCheckpointRecord => ({
        runId,
        turnId: `turn-${runId}`,
        commit,
        start: first,
        notes: first,
        views: checkpointViews,
      });
      const pinnedRecord = checkpoint("run-pinned", second, priorViews);
      const targetRecord = checkpoint("run-target", first, views);
      const laterRecord = checkpoint("run-later", second, priorViews);
      expect((yield* handle.recordCheckpoint(writer("t1"), pinnedRecord))._tag).toBe("ok");
      expect((yield* handle.recordCheckpoint(writer("t1"), targetRecord))._tag).toBe("ok");
      expect((yield* handle.recordCheckpoint(writer("t1"), laterRecord))._tag).toBe("ok");

      const beforePin = yield* handle.refs("t1");
      expect(beforePin).toMatchObject({ thread: second, wip: third });
      const pinRestore = yield* handle.restoreCheckpoint("user_1", {
        threadId: "t1",
        runId: "run-pinned",
        operationId: "pin-restore",
        expectedThread: second,
        expectedWip: third,
        generation: 1,
      });
      expect(pinRestore).toMatchObject({ _tag: "ok", generation: 2 });
      expect(
        (yield* handle.updateRefs(writer("t1", 2), [
          { name: wipRef("t1"), old: second, new: third },
        ]))._tag,
      ).toBe("ok");

      const beforeRestore = yield* handle.refs("t1");
      expect(beforeRestore).toMatchObject({
        thread: second,
        wip: third,
        pinnedViews: priorViews,
        revision: "pin-restore",
      });
      const packsBeforeRestore = (yield* handle.refs(null)).packs.map((pack) => pack.name);
      const objectsBeforeRestore = (yield* handle.locate([first, second, third]))
        .map((object) => object.oid)
        .toSorted();

      const restored = yield* handle.restoreCheckpoint("user_1", {
        threadId: "t1",
        runId: "run-target",
        operationId: "restore-1",
        expectedThread: second,
        expectedWip: third,
        generation: 2,
      });
      expect(restored).toMatchObject({
        _tag: "ok",
        generation: 3,
        refs: { thread: first, wip: first, pinnedViews: views, revision: "restore-1" },
      });
      expect(yield* storedRef(DriveRevisions.restoreSnapshotRef("t1", "restore-1", "thread"))).toBe(
        second,
      );
      expect(yield* storedRef(DriveRevisions.restoreSnapshotRef("t1", "restore-1", "wip"))).toBe(
        third,
      );
      expect(
        yield* handle.ref(DriveRevisions.restoreSnapshotRef("t1", "restore-1", "wip")),
      ).toBeNull();

      const undo1 = {
        threadId: "t1",
        restoreOperationId: "restore-1",
        operationId: "undo-1",
        expectedThread: first,
        expectedWip: first,
        generation: 3,
      } as const;
      const undone = yield* undoRestore("user_1", undo1);
      expect(undone).toMatchObject({
        _tag: "ok",
        generation: 4,
        refs: { thread: second, wip: third, pinnedViews: priorViews, revision: "pin-restore" },
      });
      expect((yield* handle.refs(null)).packs.map((pack) => pack.name)).toEqual(packsBeforeRestore);
      expect(
        (yield* handle.locate([first, second, third])).map((object) => object.oid).toSorted(),
      ).toEqual(objectsBeforeRestore);
      expect(yield* handle.checkpoint("t1", "run-later")).toEqual(laterRecord);
      expect(yield* storedRef(DriveRevisions.checkpointRef("t1", "run-later"))).toBe(second);

      const restoredAgain = yield* handle.restoreCheckpoint("user_1", {
        threadId: "t1",
        runId: "run-target",
        operationId: "restore-2",
        expectedThread: second,
        expectedWip: third,
        generation: 4,
      });
      expect(restoredAgain).toMatchObject({ _tag: "ok", generation: 5 });
      git.write("README.md", "fourth\n");
      const fourth = git.commit("fourth");
      expect((yield* uploadDirect(git.pack([fourth], [third])))._tag).toBe("ok");
      const packsBeforeSecondUndo = (yield* handle.refs(null)).packs.map((pack) => pack.name);
      const objectsBeforeSecondUndo = (yield* handle.locate([first, second, third, fourth]))
        .map((object) => object.oid)
        .toSorted();
      expect(
        (yield* handle.updateRefs(writer("t1", 5), [
          { name: wipRef("t1"), old: first, new: fourth },
        ]))._tag,
      ).toBe("ok");

      const staleUndo = {
        threadId: "t1",
        restoreOperationId: "restore-2",
        operationId: "undo-2-stale",
        expectedThread: first,
        expectedWip: first,
        generation: 5,
      } as const;
      expect(yield* undoRestore("user_1", staleUndo)).toMatchObject({
        _tag: "conflict",
        generation: 5,
        refs: { thread: first, wip: fourth },
      });
      const confirmedUndo = {
        ...staleUndo,
        operationId: "undo-2",
        expectedWip: fourth,
      } as const;
      const undoneAgain = yield* undoRestore("user_1", confirmedUndo);
      expect(undoneAgain).toMatchObject({
        _tag: "ok",
        generation: 6,
        refs: { thread: second, wip: third, pinnedViews: priorViews, revision: "pin-restore" },
      });
      expect(yield* storedRef(DriveRevisions.restoreUndoRef("t1", "undo-2", "wip"))).toBe(fourth);
      expect((yield* handle.refs(null)).packs.map((pack) => pack.name)).toEqual(
        packsBeforeSecondUndo,
      );
      expect(
        (yield* handle.locate([first, second, third, fourth]))
          .map((object) => object.oid)
          .toSorted(),
      ).toEqual(objectsBeforeSecondUndo);

      const restoreReplay = yield* handle.restoreCheckpoint("user_1", {
        threadId: "t1",
        runId: "run-target",
        operationId: "restore-2",
        expectedThread: second,
        expectedWip: third,
        generation: 4,
      });
      expect(restoreReplay).toMatchObject({
        _tag: "ok",
        generation: 6,
        refs: { thread: second, wip: third },
      });
      const undoReplay = yield* undoRestore("user_1", confirmedUndo);
      expect(undoReplay).toMatchObject({ _tag: "ok", generation: 6, refs: { wip: third } });

      expect(
        (yield* undoRestore("user_1", {
          ...confirmedUndo,
          operationId: "undo-missing",
          restoreOperationId: "missing-restore",
        }))._tag,
      ).toBe("refused");
      expect(
        (yield* undoRestore("removed", {
          ...confirmedUndo,
          operationId: "undo-revoked",
        }))._tag,
      ).toBe("refused");
      expect(
        (yield* handle.updateToLatest("user_1", {
          threadId: "t1",
          operationId: "unsafe-generation",
          expectedThread: second,
          expectedWip: third,
          generation: Number.MAX_SAFE_INTEGER + 1,
        }))._tag,
      ).toBe("refused");
    }).pipe(Effect.provide(layer));
  });

  it.effect("undoes a restore when the thread had no branch or autosave", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const handle = yield* DriveDirectory.use((directory) =>
        Effect.succeed(directory.forDrive(DRIVE)),
      );
      const git = repo();
      git.write("README.md", "checkpoint\n");
      const checkpointCommit = git.commit("checkpoint");
      expect((yield* upload(drives, git.pack([checkpointCommit]), "empty"))._tag).toBe("ok");
      expect((yield* handle.open(writer("empty")))._tag).toBe("ok");
      expect(yield* handle.refs("empty")).toMatchObject({ thread: null, wip: null });

      const record: DriveCheckpointRecord = {
        runId: "empty-run",
        turnId: "empty-turn",
        commit: checkpointCommit,
        start: null,
        notes: checkpointCommit,
        views,
      };
      expect((yield* handle.recordCheckpoint(writer("empty"), record))._tag).toBe("ok");
      const restored = yield* handle.restoreCheckpoint("user_1", {
        threadId: "empty",
        runId: record.runId,
        operationId: "restore-empty",
        expectedThread: null,
        expectedWip: null,
        generation: 1,
      });
      expect(restored).toMatchObject({
        _tag: "ok",
        generation: 2,
        refs: { thread: checkpointCommit, wip: checkpointCommit },
      });

      const undone = yield* handle.undoRestore("user_1", {
        threadId: "empty",
        restoreOperationId: "restore-empty",
        operationId: "undo-empty",
        expectedThread: checkpointCommit,
        expectedWip: checkpointCommit,
        generation: 2,
      });
      expect(undone).toMatchObject({
        _tag: "ok",
        generation: 3,
        refs: { thread: null, wip: null, pinnedViews: null, revision: null },
      });
      expect(yield* handle.checkpoint("empty", record.runId)).toEqual(record);
    }).pipe(Effect.provide(drives.layer));
  });

  it.effect("upgrades revision recovery tables without rewriting existing receipts", () => {
    const layer = DriveStore.layer("my/personal/user_upgrade").pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE packs (seq INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`CREATE TABLE remote (id INTEGER PRIMARY KEY)`;
      yield* sql`CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY, base TEXT, generation INTEGER NOT NULL, opened_at INTEGER NOT NULL
      )`;
      yield* DriveRevisions.createTables.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      yield* sql`INSERT INTO drive_revision_operations
        (thread_id, operation_id, kind, request_json, created_at)
        VALUES ('legacy-thread', 'legacy-restore', 'restore', '{}', 0)`;
      yield* DriveEvents.createTables;
      yield* sql`CREATE TABLE effect_sql_migrations (
        migration_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL,
        PRIMARY KEY (migration_id, name)
      )`;
      for (const [migrationId, name] of [
        [1, "drive"],
        [2, "access"],
        [3, "remote"],
        [4, "promised"],
        [5, "private_packs"],
        [6, "ref_events"],
        [7, "drive_revisions"],
      ] as const) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${name})`;
      }

      yield* DriveStore.DriveStore.use((store) => store.initialize);
      const snapshots = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'drive_restore_snapshots'`;
      const applied = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 7
        ORDER BY migration_id, name`;
      expect(snapshots).toHaveLength(1);
      expect(applied.map(({ migration_id, name }) => [migration_id, name])).toEqual([
        [7, "drive_revisions"],
        [8, "drive_restore_snapshots"],
        [9, "ref_deletions"],
        [10, "drive_pull_receipts"],
        [10, "drive_repository_publication"],
        [10, "restore_requesters"],
        [10, "shared_history_packs"],
        [11, "drive_publication_creation_attempts"],
        [11, "shared_history_transfers"],
      ]);
      expect(
        yield* sql`SELECT operation_id, request_json, requester_id FROM drive_revision_operations`,
      ).toEqual([{ operation_id: "legacy-restore", request_json: "{}", requester_id: null }]);
    }).pipe(Effect.provide(layer));
  });
});
