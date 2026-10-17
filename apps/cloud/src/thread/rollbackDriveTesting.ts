import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";

import * as DriveDirectory from "../drive/DriveDirectory.ts";
import * as DriveMembers from "../drive/DriveMembers.ts";
import * as DriveStore from "../drive/DriveStore.ts";
import type { RestoreCheckpointRequest } from "../drive/DriveStore.ts";
import { makeDriveObjectApi } from "../drive/driveObjectApi.ts";
import { makeRepo, registerPack } from "../drive/driveTesting.ts";
import type * as DriveEvents from "../drive/DriveEvents.ts";
import { liveTurn, owner, personal, threadId, turnReport } from "./runnerTesting.ts";
import type * as ThreadRunner from "./runner/ThreadRunner.ts";

const driveId = "shared/work/undo-recovery";
const manager = { userId: "manager", email: "manager@example.test", name: null };
const person = { userId: owner.userId, email: "owner@example.test", name: null };

/** Real Drive persistence, with only transport loss and concurrent membership/ref changes injected. */
export const realDrive = Effect.gen(function* () {
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() =>
      ManagedRuntime.make(
        DriveStore.layer(driveId).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
    (value) => Effect.promise(() => value.dispose()),
  );
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | DriveStore.DriveStore
      | DriveMembers.DriveMembers
      | DriveEvents.DriveEvents
      | SqlClient.SqlClient
    >,
  ) => Effect.promise(() => runtime.runPromise(effect));
  const store = yield* run(DriveStore.DriveStore);
  const members = yield* run(DriveMembers.DriveMembers);
  const sql = yield* run(SqlClient.SqlClient);
  yield* run(store.initialize);
  yield* run(
    members.setup({
      name: "Undo recovery",
      members: [
        { ...manager, role: "manager" },
        { ...person, role: "contributor" },
      ],
    }),
  );
  const git = yield* Effect.acquireRelease(Effect.sync(makeRepo), (repo) =>
    Effect.sync(repo.cleanup),
  );
  const commit = (name: string) => {
    git.write("README.md", `${name}\n`);
    return git.commit(name);
  };
  const first = commit("first");
  const second = commit("second");
  const concurrent = commit("concurrent");
  expect((yield* run(registerPack(threadId, git.pack([concurrent]))))._tag).toBe("ok");
  const base = makeDriveObjectApi((effect) => runtime.runPromise(effect));
  const calls: Array<RestoreCheckpointRequest> = [];
  const state = {
    loseResponse: false,
    returnRefusalAfterCommit: false,
    revokeBeforeRestore: false,
    conflictBeforeRestore: false,
  };
  const writer = (generation: number) => ({
    threadId,
    userId: owner.userId,
    generation,
    live: false,
    packsAfter: 0,
  });
  const api: DriveDirectory.DriveObjectApi = {
    ...base,
    restoreCheckpoint: async (userId, request) => {
      calls.push(request);
      if (state.revokeBeforeRestore) {
        state.revokeBeforeRestore = false;
        expect((await base.unshare(manager, owner.userId))._tag).toBe("ok");
      }
      if (state.conflictBeforeRestore) {
        state.conflictBeforeRestore = false;
        const changed = await base.updateRefs(writer(request.generation), [
          { name: DriveStore.wipRef(threadId), old: request.expectedWip, new: concurrent },
        ]);
        expect(changed._tag).toBe("ok");
      }
      const result = await base.restoreCheckpoint(userId, request);
      if (result._tag === "ok" && state.returnRefusalAfterCommit) {
        state.returnRefusalAfterCommit = false;
        expect((await base.unshare(manager, owner.userId))._tag).toBe("ok");
        return base.restoreCheckpoint(userId, request);
      }
      if (result._tag === "ok" && state.loseResponse) {
        state.loseResponse = false;
        expect((await base.unshare(manager, owner.userId))._tag).toBe("ok");
        throw new Error("Drive committed, access was revoked, and the response was lost.");
      }
      return result;
    },
  };
  const handle = DriveDirectory.handleFor(api);
  const finish = (
    runner: ThreadRunner.ThreadRunner["Service"],
    generation: number,
    sequence: number,
    commit: string,
    start: string | null,
  ) =>
    Effect.gen(function* () {
      const turn = yield* liveTurn(runner);
      expect((yield* handle.open(writer(generation)))._tag).toBe("ok");
      const refs = yield* handle.refs(threadId);
      expect(
        (yield* handle.updateRefs(writer(generation), [
          { name: DriveStore.threadRef(threadId), old: refs.thread, new: commit },
          { name: DriveStore.wipRef(threadId), old: refs.wip, new: commit },
        ]))._tag,
      ).toBe("ok");
      const record: DriveCheckpointRecord = {
        runId: turn.runId,
        turnId: `turn-${turn.runId}`,
        commit,
        start,
        notes: commit,
        views: { shortcuts: [], context: null },
      };
      expect((yield* handle.recordCheckpoint(writer(generation), record))._tag).toBe("ok");
      const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
      yield* runner.batch({
        generation,
        sequence,
        items: [
          report.started,
          report.full,
          { kind: "drive.checkpoint", runId: turn.runId, start, commit, files: [] },
          report.terminal,
        ],
      });
      return turn;
    });
  return {
    run,
    store,
    members,
    sql,
    base,
    handle,
    calls,
    state,
    first,
    second,
    concurrent,
    finish,
    writer,
    restoreAccess: () => handle.share(manager, person, "contributor"),
    creation: { ...personal, place: { ...personal.place, driveId } },
    options: {
      drives: true,
      rollbackDrives: Layer.succeed(DriveDirectory.DriveDirectory, { forDrive: () => handle }),
    },
  };
});
