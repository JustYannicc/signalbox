import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { makeMemoryCloud } from "../testing.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { DriveRefEvent } from "./DriveEvents.ts";
import * as DriveEvents from "./DriveEvents.ts";
import { MAIN_REF, machineRef, threadRef, wipRef } from "./DriveStore.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import { uploadPack } from "./DriveUploads.ts";

/**
 * #471: a drive's `main` and thread branch moves reach each person's
 * automations through the drive object's outbox, in order and at least once.
 */

const repos: Array<ReturnType<typeof makeRepo>> = [];
const repo = () => {
  const created = makeRepo();
  repos.push(created);
  return created;
};
afterEach(() => {
  for (const created of repos.splice(0)) created.cleanup();
});

const decodeMoves = Schema.decodeUnknownSync(Schema.Array(DriveRefEvent));

const writer = (userId: string, threadId: string) => ({
  threadId,
  userId,
  generation: 1,
  live: true,
  packsAfter: 0,
});

/** Drives whose people's objects record the moves that reach them; `down` makes those calls fail. */
const setup = () => {
  const received: Array<{ readonly userId: string; readonly moves: Array<DriveRefEvent> }> = [];
  const state = { down: false };
  const cloud = makeMemoryCloud();
  const users: UserDirectory.UserDirectory["Service"] = {
    ...cloud.userDirectory,
    forUser: (userId) => ({
      ...cloud.userDirectory.forUser(userId),
      driveEvents: ({ events }) =>
        state.down
          ? Effect.fail(
              new UserDirectory.UserObjectError({ operation: "driveEvents", cause: "down" }),
            )
          : Effect.sync(() => received.push({ userId, moves: [...decodeMoves(events)] })),
    }),
  };
  const drives = makeMemoryDrives({ users: () => users });
  const drive = (driveId: string) =>
    DriveDirectory.use((directory) => Effect.succeed(directory.forDrive(driveId))).pipe(
      Effect.provide(drives.layer),
    );
  const upload = (
    driveId: string,
    threadId: string,
    packed: ReturnType<ReturnType<typeof repo>["pack"]>,
  ) =>
    uploadPack({ driveId, threadId, idx: packed.idx, pack: packed.pack }).pipe(
      Effect.provide(drives.layer),
    );
  return { received, state, drive, upload };
};

const refsOf = (moves: ReadonlyArray<DriveRefEvent>) =>
  moves.map((move) => [move.ref, move.before, move.after]);

describe("drive events", () => {
  it.effect("undoing a restore to an unborn branch delivers its deletion", () =>
    Effect.gen(function* () {
      const { received, drive, upload } = setup();
      const driveId = "my/personal/user_1";
      const git = repo();
      git.write("notes.md", "interrupted work\n");
      const first = git.commit("Interrupted turn");
      yield* upload(driveId, "t1", git.pack([first]));
      const handle = yield* drive(driveId);
      const as = writer("user_1", "t1");
      yield* handle.open(as);
      yield* handle.updateRefs(as, [{ name: wipRef("t1"), old: null, new: first }]);
      expect(
        (yield* handle.recordCheckpoint(as, {
          runId: "interrupted-run",
          turnId: "interrupted-turn",
          commit: first,
          start: null,
          notes: first,
          views: { shortcuts: [], context: null },
        }))._tag,
      ).toBe("ok");
      expect(
        (yield* handle.restoreCheckpoint("user_1", {
          threadId: "t1",
          runId: "interrupted-run",
          operationId: "restore",
          expectedThread: null,
          expectedWip: first,
          generation: 1,
        }))._tag,
      ).toBe("ok");
      expect(
        yield* handle.undoRestore("user_1", {
          threadId: "t1",
          restoreOperationId: "restore",
          operationId: "undo",
          expectedThread: first,
          expectedWip: first,
          generation: 2,
        }),
      ).toMatchObject({ _tag: "ok", refs: { thread: null, wip: first } });
      const moves = received.flatMap((delivery) => delivery.moves);
      expect(refsOf(moves)).toEqual([
        [threadRef("t1"), null, first],
        [threadRef("t1"), first, null],
      ]);
      expect(moves[1]).toMatchObject({ commits: [], commitsTruncated: false });
    }),
  );

  it.effect("upgrades pending events without reusing pruned sequence numbers", () => {
    const layer = DriveEvents.layer("my/personal/user_1").pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* DriveEvents.createTables;
      yield* sql`CREATE TABLE members (user_id TEXT, role TEXT)`;
      const events = yield* DriveEvents.DriveEvents;
      const first = { ref: "threads/t1", before: null, after: "first", threadId: "t1" };
      yield* events.record(first);
      yield* events.record({ ...first, after: "second" });
      yield* events.record({ ...first, after: "third" });
      yield* sql`DELETE FROM ref_events WHERE seq > 1`;
      yield* sql`DELETE FROM ref_event_deliveries WHERE seq > 1`;
      const pending = yield* events.pending("user_1", 10);
      yield* DriveEvents.allowDeletedRefs.pipe(sql.withTransaction);
      expect(yield* events.pending("user_1", 10)).toEqual(pending);
      yield* events.record({ ...first, before: "first", after: null });
      expect(yield* events.pending("user_1", 10)).toMatchObject([
        { sequence: 1, after: "first" },
        { sequence: 4, before: "first", after: null },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("main and branch moves reach the owner in order, and a failed call is sent again", () =>
    Effect.gen(function* () {
      const { received, state, drive, upload } = setup();
      const driveId = "my/personal/user_1";
      const git = repo();
      git.write("notes.md", "one\n");
      const first = git.commit("Add notes");
      yield* upload(driveId, "t1", git.pack([first]));
      const handle = yield* drive(driveId);
      const as = writer("user_1", "t1");
      yield* handle.open(as);

      // An auto-save alone is nobody's landed work.
      yield* handle.updateRefs(as, [{ name: wipRef("t1"), old: null, new: first }]);
      yield* handle.updateRefs(as, [{ name: machineRef("t1"), old: null, new: first }]);
      expect(received).toEqual([]);

      yield* handle.updateRefs(as, [
        { name: threadRef("t1"), old: null, new: first },
        { name: wipRef("t1"), old: first, new: first },
      ]);
      yield* handle.reconcile(as, { expectedMain: null, newMain: first });
      // A retry of a write that landed moves nothing.
      yield* handle.reconcile(as, { expectedMain: null, newMain: first });
      const moves = received.flatMap((delivery) => delivery.moves);
      expect(received.every((delivery) => delivery.userId === "user_1")).toBe(true);
      expect(refsOf(moves)).toEqual([
        [threadRef("t1"), null, first],
        [MAIN_REF, null, first],
      ]);
      expect(moves.map((move) => move.threadId)).toEqual(["t1", "t1"]);
      expect(moves[1]!.commits).toEqual([
        { oid: first, author: "Test", message: "Add notes\n", parents: [] },
      ]);

      // The owner's object is down: the move waits, and goes with the next delivery.
      git.write("notes.md", "two\n");
      const second = git.commit("Edit notes");
      yield* upload(driveId, "t1", git.pack([second], [first]));
      state.down = true;
      yield* handle.updateRefs(as, [{ name: threadRef("t1"), old: first, new: second }]);
      state.down = false;
      received.length = 0;
      yield* handle.reconcile(as, { expectedMain: first, newMain: second });
      const later = received.flatMap((delivery) => delivery.moves);
      expect(refsOf(later)).toEqual([
        [threadRef("t1"), first, second],
        [MAIN_REF, first, second],
      ]);
      expect(later[1]!.commits.map((commit) => commit.oid)).toEqual([second]);
      expect(later[1]!.sequence).toBeGreaterThan(moves[1]!.sequence);
    }),
  );

  it.effect("everyone in a shared folder gets its moves, until they're removed", () =>
    Effect.gen(function* () {
      const { received, state, drive, upload } = setup();
      const driveId = "folder/personal/plans";
      const owner = { userId: "user_1", email: "a@b.c", name: "A" };
      const handle = yield* drive(driveId);
      yield* handle.setup({
        name: "Plans",
        members: [
          { ...owner, role: "owner" },
          { userId: "user_2", email: "b@b.c", name: "B", role: "editor" },
        ],
      });
      const git = repo();
      git.write("plan.md", "a\n");
      const first = git.commit("Plan");
      yield* upload(driveId, "t1", git.pack([first]));
      const as = writer("user_1", "t1");
      yield* handle.open(as);
      yield* handle.updateRefs(as, [{ name: threadRef("t1"), old: null, new: first }]);
      expect(received.map((delivery) => delivery.userId).toSorted()).toEqual(["user_1", "user_2"]);

      // Someone removed while their moves wait gets none of them.
      git.write("plan.md", "b\n");
      const second = git.commit("Replan");
      yield* upload(driveId, "t1", git.pack([second], [first]));
      state.down = true;
      yield* handle.updateRefs(as, [{ name: threadRef("t1"), old: first, new: second }]);
      yield* handle.unshare(owner, "user_2");
      state.down = false;
      received.length = 0;
      yield* handle.reconcile(as, { expectedMain: null, newMain: second });
      expect(received.map((delivery) => delivery.userId)).toEqual(["user_1"]);
      expect(refsOf(received.flatMap((delivery) => delivery.moves))).toEqual([
        [threadRef("t1"), first, second],
        [MAIN_REF, null, second],
      ]);
    }),
  );
});
