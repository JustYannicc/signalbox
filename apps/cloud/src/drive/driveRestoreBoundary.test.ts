import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { DriveMembers } from "./DriveMembers.ts";
import { DriveStore, layer as driveLayer, machineRef, threadRef, wipRef } from "./DriveStore.ts";
import { makeRepo, registerPack } from "./driveTesting.ts";

const manager = { userId: "manager", email: "manager@example.test", name: null };
const editor = { userId: "editor", email: "editor@example.test", name: null };
const layer = driveLayer("shared/work/restore-boundary").pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const writer = (generation = 1, threadId = "t1") => ({
  threadId,
  userId: editor.userId,
  generation,
  live: true,
  packsAfter: 0,
});
const repos: Array<ReturnType<typeof makeRepo>> = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
});

const fixture = Effect.gen(function* () {
  const store = yield* DriveStore;
  const members = yield* DriveMembers;
  yield* store.initialize;
  yield* members.setup({
    name: "Restore boundary",
    members: [
      { ...manager, role: "manager" },
      { ...editor, role: "contributor" },
    ],
  });
  const git = makeRepo();
  repos.push(git);
  const commit = (name: string) => {
    git.write("README.md", `${name}\n`);
    return git.commit(name);
  };
  const previous = commit("previous-checkpoint");
  const first = commit("selected-start");
  const second = commit("second");
  const third = commit("third");
  const autosave = commit("autosave");
  expect((yield* registerPack("t1", git.pack([autosave])))._tag).toBe("ok");
  expect((yield* store.open(writer()))._tag).toBe("ok");
  expect(
    (yield* store.updateRefs(writer(), [{ name: threadRef("t1"), old: null, new: first }]))._tag,
  ).toBe("ok");
  expect((yield* store.reconcile(writer(), { expectedMain: null, newMain: first }))._tag).toBe(
    "ok",
  );
  expect((yield* store.open(writer(1, "other")))._tag).toBe("ok");
  expect(
    (yield* store.updateRefs(writer(), [
      { name: threadRef("t1"), old: first, new: third },
      { name: wipRef("t1"), old: null, new: autosave },
      { name: machineRef("t1"), old: null, new: autosave },
    ]))._tag,
  ).toBe("ok");
  expect((yield* store.reconcile(writer(), { expectedMain: first, newMain: third }))._tag).toBe(
    "ok",
  );
  const record = (runId: string, commit: string, start: string | null): DriveCheckpointRecord => ({
    runId,
    turnId: `turn-${runId}`,
    commit,
    start,
    notes: commit,
    views: {
      shortcuts: [{ path: runId, target: "my/personal/docs", commit: first }],
      context: null,
    },
  });
  const initial = record("initial", previous, null);
  const selected = record("selected", second, first);
  const later = record("later", third, second);
  for (const checkpoint of [initial, selected, later]) {
    expect((yield* store.recordCheckpoint(writer(), checkpoint))._tag).toBe("ok");
  }
  const request = {
    threadId: "t1",
    runId: selected.runId,
    operationId: "restore-start",
    boundary: "start" as const,
    expectedThread: third,
    expectedWip: autosave,
    generation: 1,
  };
  return {
    store,
    members,
    first,
    second,
    third,
    autosave,
    initial,
    selected,
    later,
    request,
  };
});

describe("drive restore boundaries", () => {
  it.effect(
    "restores the exact start, retries without reapplying it, and undoes distinct autosaved work",
    () =>
      Effect.gen(function* () {
        const { store, first, second, third, autosave, selected, later, request } = yield* fixture;
        const before = yield* store.refs("t1");
        const other = yield* store.refs("other");
        expect(yield* store.restoreCheckpoint(editor.userId, request)).toMatchObject({
          _tag: "ok",
          generation: 2,
          refs: {
            main: third,
            thread: first,
            wip: first,
            machine: autosave,
            notes: third,
            pinnedViews: selected.views,
            revision: request.operationId,
          },
        });
        expect(
          (yield* store.updateRefs(writer(), [{ name: wipRef("t1"), old: first, new: second }]))
            ._tag,
        ).toBe("refused");
        expect(
          (yield* store.updateRefs(writer(2), [{ name: wipRef("t1"), old: first, new: second }]))
            ._tag,
        ).toBe("ok");
        expect(yield* store.restoreCheckpoint(editor.userId, request)).toMatchObject({
          _tag: "ok",
          generation: 2,
          refs: { thread: first, wip: second },
        });
        const undo = {
          threadId: "t1",
          restoreOperationId: request.operationId,
          operationId: "undo-start",
          expectedThread: first,
          expectedWip: second,
          generation: 2,
        };
        expect(yield* store.undoRestore(editor.userId, undo)).toMatchObject({
          _tag: "ok",
          generation: 3,
          refs: before,
        });
        expect(yield* store.undoRestore(editor.userId, undo)).toMatchObject({
          _tag: "ok",
          generation: 3,
          refs: before,
        });
        expect(yield* store.refs("other")).toEqual(other);
        expect(yield* store.checkpoint("t1", later.runId)).toEqual(later);
        expect(yield* store.restoreCheckpoint(editor.userId, request)).toMatchObject({
          _tag: "ok",
          generation: 3,
          refs: before,
        });
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`SELECT oid FROM refs WHERE name = 'signalbox/restores/t1/restore-start/before-wip'`,
        ).toEqual([{ oid: autosave }]);
        expect(
          yield* sql`SELECT oid FROM refs WHERE name = 'signalbox/restore-undos/t1/undo-start/wip'`,
        ).toEqual([{ oid: second }]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("defaults to end and distinguishes start receipts from existing end receipts", () =>
    Effect.gen(function* () {
      const { store, first, second, request } = yield* fixture;
      const { boundary: _boundary, ...end } = request;
      expect(yield* store.restoreCheckpoint(editor.userId, end)).toMatchObject({
        _tag: "ok",
        generation: 2,
        refs: { thread: second, wip: second },
      });
      const sql = yield* SqlClient.SqlClient;
      const legacyRequest = JSON.stringify({
        threadId: end.threadId,
        runId: end.runId,
        expectedThread: end.expectedThread,
        expectedWip: end.expectedWip,
        generation: end.generation,
      });
      yield* sql`UPDATE drive_revision_operations SET request_json = ${legacyRequest}
        WHERE thread_id = ${end.threadId} AND operation_id = ${end.operationId}`;
      expect(yield* store.restoreCheckpoint(editor.userId, end)).toMatchObject({
        _tag: "ok",
        generation: 2,
      });
      expect(
        yield* store.restoreCheckpoint(editor.userId, { ...end, boundary: "end" }),
      ).toMatchObject({ _tag: "ok", generation: 2 });
      expect((yield* store.restoreCheckpoint(editor.userId, request))._tag).toBe("refused");
      const start = {
        ...request,
        operationId: "new-start",
        expectedThread: second,
        expectedWip: second,
        generation: 2,
      };
      expect(yield* store.restoreCheckpoint(editor.userId, start)).toMatchObject({
        _tag: "ok",
        generation: 3,
        refs: { thread: first, wip: first },
      });
      expect(
        (yield* store.restoreCheckpoint(editor.userId, { ...start, boundary: "end" }))._tag,
      ).toBe("refused");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "restores a null initial start as empty refs even after main advances and preserves undo",
    () =>
      Effect.gen(function* () {
        const { store, third, autosave, initial, later, request } = yield* fixture;
        const before = yield* store.refs("t1");
        const start = { ...request, runId: initial.runId };
        expect(yield* store.restoreCheckpoint(editor.userId, start)).toMatchObject({
          _tag: "ok",
          generation: 2,
          refs: {
            main: third,
            thread: null,
            wip: null,
            machine: autosave,
            notes: third,
            pinnedViews: initial.views,
            revision: start.operationId,
          },
        });
        expect(yield* store.open(writer(2))).toMatchObject({
          _tag: "ok",
          refs: {
            main: third,
            thread: null,
            wip: null,
            pinnedViews: initial.views,
            revision: start.operationId,
          },
        });
        expect(yield* store.restoreCheckpoint(editor.userId, start)).toMatchObject({
          _tag: "ok",
          generation: 2,
          refs: { thread: null, wip: null },
        });
        expect(
          yield* store.undoRestore(editor.userId, {
            threadId: "t1",
            restoreOperationId: start.operationId,
            operationId: "undo-empty",
            expectedThread: null,
            expectedWip: null,
            generation: 2,
          }),
        ).toMatchObject({ _tag: "ok", generation: 3, refs: before });
        expect(yield* store.checkpoint("t1", later.runId)).toEqual(later);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects stale refs and generations without consuming the restore id", () =>
    Effect.gen(function* () {
      const { store, first, third, request } = yield* fixture;
      const before = yield* store.refs("t1");
      for (const stale of [{ expectedThread: first }, { expectedWip: first }]) {
        expect(
          yield* store.restoreCheckpoint(editor.userId, { ...request, ...stale }),
        ).toMatchObject({ _tag: "conflict", generation: 1, refs: before });
      }
      expect(
        yield* store.restoreCheckpoint(editor.userId, { ...request, generation: 0 }),
      ).toMatchObject({ _tag: "refused", generation: 1 });
      expect(yield* store.refs("t1")).toEqual(before);
      expect(yield* store.restoreCheckpoint(editor.userId, request)).toMatchObject({
        _tag: "ok",
        generation: 2,
      });
      expect(
        yield* store.undoRestore(editor.userId, {
          threadId: "t1",
          restoreOperationId: request.operationId,
          operationId: "undo-stale",
          expectedThread: third,
          expectedWip: first,
          generation: 2,
        }),
      ).toMatchObject({ _tag: "conflict", generation: 2 });
      expect(yield* store.refs("t1")).toMatchObject({ thread: first, wip: first });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks revoked access before restores, retries, and undo", () =>
    Effect.gen(function* () {
      const { store, members, first, request } = yield* fixture;
      expect((yield* store.restoreCheckpoint(editor.userId, request))._tag).toBe("ok");
      expect((yield* members.unshare(manager, editor.userId))._tag).toBe("ok");
      const before = yield* store.refs("t1");
      for (const operationId of [request.operationId, "revoked-start"]) {
        expect(
          (yield* store.restoreCheckpoint(editor.userId, { ...request, operationId }))._tag,
        ).toBe("refused");
      }
      expect(
        (yield* store.undoRestore(editor.userId, {
          threadId: "t1",
          restoreOperationId: request.operationId,
          operationId: "revoked-undo",
          expectedThread: first,
          expectedWip: first,
          generation: 2,
        }))._tag,
      ).toBe("refused");
      expect(yield* store.refs("t1")).toEqual(before);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("raises only the existing thread fence and never changes refs", () =>
    Effect.gen(function* () {
      const { store, first, request } = yield* fixture;
      const before = yield* store.refs("t1");
      const other = yield* store.refs("other");
      expect(yield* store.advanceThreadFence("missing", 3)).toEqual({ _tag: "missing" });
      expect(yield* store.advanceThreadFence("t1", 3)).toEqual({ _tag: "ok", generation: 3 });
      expect(yield* store.advanceThreadFence("t1", 2)).toEqual({ _tag: "ok", generation: 3 });
      expect(yield* store.refs("t1")).toEqual(before);
      expect(yield* store.refs("other")).toEqual(other);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT thread_id, generation FROM threads ORDER BY thread_id`).toEqual([
        { thread_id: "other", generation: 1 },
        { thread_id: "t1", generation: 3 },
      ]);
      expect(
        (yield* store.updateRefs(writer(1), [{ name: wipRef("t1"), old: before.wip, new: first }]))
          ._tag,
      ).toBe("refused");
      expect((yield* store.restoreCheckpoint(editor.userId, request))._tag).toBe("refused");
      expect(yield* store.restoreCheckpointStatus(editor.userId, request)).toBe("not-committed");
      expect(
        (yield* store.restoreCheckpoint(editor.userId, { ...request, generation: 3 }))._tag,
      ).toBe("ok");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "binds internal committed evidence to the requester and exact request while public replay stays authorized",
    () =>
      Effect.gen(function* () {
        const { store, members, first, request } = yield* fixture;
        expect(yield* store.restoreCheckpointStatus(editor.userId, request)).toBe("not-committed");
        expect((yield* store.restoreCheckpoint(editor.userId, request))._tag).toBe("ok");
        expect(yield* store.restoreCheckpointStatus(manager.userId, request)).toBe("not-committed");
        for (const changed of [
          { threadId: "other" },
          { runId: "other-run" },
          { operationId: "other-operation" },
          { boundary: "end" as const },
          { expectedThread: first },
          { expectedWip: first },
          { generation: 2 },
        ]) {
          expect(
            yield* store.restoreCheckpointStatus(editor.userId, { ...request, ...changed }),
          ).toBe("not-committed");
        }
        expect((yield* members.unshare(manager, editor.userId))._tag).toBe("ok");
        const before = yield* store.refs("t1");
        expect(yield* store.restoreCheckpointStatus(editor.userId, request)).toBe("committed");
        expect(yield* store.restoreCheckpoint(editor.userId, request)).toEqual({
          _tag: "refused",
          reason: "You no longer have access to change this drive.",
        });
        expect(yield* store.refs("t1")).toEqual(before);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps legacy receipts without a recorded requester unverified", () =>
    Effect.gen(function* () {
      const { store, members, request } = yield* fixture;
      expect((yield* store.restoreCheckpoint(editor.userId, request))._tag).toBe("ok");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE drive_revision_operations SET requester_id = NULL`;
      expect((yield* members.unshare(manager, editor.userId))._tag).toBe("ok");
      expect(yield* store.restoreCheckpointStatus(editor.userId, request)).toBe("unverified");
      expect((yield* store.restoreCheckpoint(editor.userId, request))._tag).toBe("refused");
    }).pipe(Effect.provide(layer)),
  );
});
