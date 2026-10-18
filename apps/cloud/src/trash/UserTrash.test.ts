import { ThreadId } from "@t3tools/contracts";
import { NoteId } from "@t3tools/contracts/signalboxNotes";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { PERSONAL_CONTEXT_ID, type SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemoryStore } from "../testing.ts";
import { UserDrives } from "../user/UserDrives.ts";
import { UserStore } from "../user/UserStore.ts";
import type { FolderTrashRestorePreflight } from "../user/UserFolders.ts";
import { TrashResources, type FolderTrash } from "./TrashResources.ts";
import { TrashAlarm, TrashWorkflow } from "./TrashWorkflow.ts";
import { RETENTION_MS, RETRY_MS } from "./trashTables.ts";
import { UserTrash, layer } from "./UserTrash.ts";

const INITIAL = 1_000_000;

const fixture = (enabled = true) => {
  const calls: string[] = [];
  const starts: string[] = [];
  const alarms: Array<number> = [];
  let unjournaledFolders: ReadonlyArray<FolderTrash> = [];
  const restorePreflights = new Map<string, FolderTrashRestorePreflight>();
  let ready = true;
  let failRestore = false;
  let contextIds: ReadonlyArray<SignalboxContextId> = [PERSONAL_CONTEXT_ID];
  const resources = Layer.succeed(TrashResources, {
    describeThread: (_actor, threadId) =>
      Effect.succeed({
        title: "A thread",
        contextId: "personal",
        target: { threadId, driveId: "my/personal/u1" },
        plannedRemovals: [
          { _tag: "threadResource", threadId: ThreadId.make(threadId), resource: "history" },
          { _tag: "threadResource", threadId: ThreadId.make(threadId), resource: "machine-cache" },
          { _tag: "threadResource", threadId: ThreadId.make(threadId), resource: "previews" },
          { _tag: "threadResource", threadId: ThreadId.make(threadId), resource: "attachments" },
          {
            _tag: "threadResource",
            threadId: ThreadId.make(threadId),
            resource: "automation-runs",
          },
          { _tag: "driveThreadRefs", driveId: "my/personal/u1", threadId: ThreadId.make(threadId) },
        ],
      }),
    trashFolder: (_actor, folderId) =>
      Effect.succeed({
        id: "folder-trash-1",
        folderId,
        title: "Work",
        contextId: "personal",
        deletedAt: INITIAL,
        purgeAfter: INITIAL + RETENTION_MS,
        targets: [{ threadId: ThreadId.make("nested-thread"), driveId: "folder-drive" }],
        driveIds: ["folder-drive"],
        plannedRemovals: [
          { _tag: "threadResource", threadId: ThreadId.make("nested-thread"), resource: "history" },
          {
            _tag: "threadResource",
            threadId: ThreadId.make("nested-thread"),
            resource: "machine-cache",
          },
          {
            _tag: "threadResource",
            threadId: ThreadId.make("nested-thread"),
            resource: "previews",
          },
          {
            _tag: "threadResource",
            threadId: ThreadId.make("nested-thread"),
            resource: "attachments",
          },
          {
            _tag: "threadResource",
            threadId: ThreadId.make("nested-thread"),
            resource: "automation-runs",
          },
          {
            _tag: "driveThreadRefs",
            driveId: "folder-drive",
            threadId: ThreadId.make("nested-thread"),
          },
          { _tag: "folder", folderId: FolderId.make("folder-1") },
          { _tag: "folder", folderId: FolderId.make("folder-child") },
          { _tag: "note", noteId: NoteId.make("note-1") },
          { _tag: "drive", driveId: "folder-drive", onlyIfUnshared: true },
        ],
      }),
    folderTrashes: () => Effect.sync(() => unjournaledFolders),
    folderRestorePreflight: (_actor, folder) =>
      Effect.succeed(
        restorePreflights.get(folder.id) ?? { status: "trashed", parentTrashedAt: null },
      ),
    trashedHomeOfThread: () => Effect.succeed(null),
    prepare: (_actor, row) =>
      Effect.sync(() => {
        calls.push(`trash:${row.id}`);
        return ready;
      }),
    restore: (_actor, row) =>
      Effect.suspend(() => {
        calls.push(`restore:${row.id}`);
        if (failRestore) {
          failRestore = false;
          return Effect.fail(
            new SignalboxTrashError({ message: "The thread is temporarily unreachable." }),
          );
        }
        return Effect.void;
      }),
  });
  const services = layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        resources,
        Layer.succeed(TrashAlarm, {
          armBy: (at) => Effect.sync(() => void alarms.push(at)),
        }),
        Layer.succeed(TrashWorkflow, {
          enabled,
          start: (_user, id) =>
            Effect.suspend(() => {
              starts.push(id);
              return Effect.void;
            }),
        }),
        Layer.succeed(UserDrives, {
          userId: Effect.succeed("u1"),
          contextIds: Effect.sync(() => contextIds),
          drives: Effect.succeed([]),
          changes: Stream.empty,
          changed: Stream.empty,
          access: () => Effect.succeed(null),
        }),
      ),
    ),
    Layer.provideMerge(layerMemoryStore),
  );
  const initialize = Effect.gen(function* () {
    yield* TestClock.setTime(INITIAL);
    const user = yield* UserStore;
    yield* user.recordSignIn({ id: "u1", email: "test@example.com" });
    return yield* UserTrash;
  });
  return {
    services,
    initialize,
    calls,
    starts,
    alarms,
    setUnjournaledFolders: (folders: ReadonlyArray<FolderTrash>) => {
      unjournaledFolders = folders;
    },
    setRestorePreflight: (id: string, preflight: FolderTrashRestorePreflight) => {
      restorePreflights.set(id, preflight);
    },
    setReady: (value: boolean) => {
      ready = value;
    },
    failNextRestore: () => {
      failRestore = true;
    },
    leave: () => {
      contextIds = [];
    },
  };
};

describe("UserTrash", () => {
  it.effect(
    "replaying the same delete command after restore never deletes the thread again",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const entry = (yield* trash.trashThread({ threadId: "thread-1", commandId: "delete-1" }))
          .entries[0]!;
        yield* trash.restore({ id: entry.id });
        const replayed = yield* trash.trashThread({ threadId: "thread-1", commandId: "delete-1" });
        expect(replayed.entries).toHaveLength(1);
        expect(replayed.entries[0]?.status).toBe("restored");
        expect(
          (yield* Effect.flip(trash.trashThread({ threadId: "other", commandId: "delete-1" })))
            .message,
        ).toContain("another item");
        const next = yield* trash.trashThread({ threadId: "thread-1", commandId: "delete-2" });
        expect(next.entries.find((row) => row.status === "trashed")?.id).not.toBe(entry.id);
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect(
    "trashes and restores the same item idempotently, then gives a new deletion a fresh fence",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const first = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
        expect(first.status).toBe("trashed");
        expect(first.purgeAfter - first.deletedAt).toBe(RETENTION_MS);
        expect(first.plannedRemovals).toHaveLength(6);
        expect(first.removals).toEqual([]);
        expect((yield* trash.trashThread({ threadId: "thread-1" })).entries).toHaveLength(1);
        expect((yield* trash.restore({ id: first.id })).entries[0]?.status).toBe("restored");
        yield* trash.restore({ id: first.id });
        expect(f.calls.filter((call) => call.startsWith("restore:"))).toHaveLength(1);
        const second = (yield* trash.trashThread({ threadId: "thread-1" })).entries.find(
          (row) => row.status === "trashed",
        )!;
        expect(second.id).not.toBe(first.id);
        expect((yield* trash.progress(first.id)).done).toBe(true);
        expect((yield* trash.list).entries.find((row) => row.id === first.id)?.removals).toEqual(
          [],
        );
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect(
    "refuses a new delete during restore but keeps the original command replay inert",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const first = (yield* trash.trashThread({ threadId: "thread-1", commandId: "delete-1" }))
          .entries[0]!;
        f.failNextRestore();
        expect((yield* trash.restore({ id: first.id })).entries[0]?.status).toBe("restoring");
        const callsBeforeDelete = [...f.calls];

        const refused = yield* Effect.flip(
          trash.trashThread({ threadId: "thread-1", commandId: "delete-2" }),
        );
        expect(refused.message).toContain("being restored");
        expect(f.calls).toEqual(callsBeforeDelete);

        expect(
          (yield* trash.trashThread({ threadId: "thread-1", commandId: "delete-1" })).entries[0]
            ?.status,
        ).toBe("restoring");
        expect(f.calls).toEqual(callsBeforeDelete);

        yield* trash.recover;
        expect((yield* trash.list).entries[0]?.status).toBe("restored");
        const next = (yield* trash.trashThread({
          threadId: "thread-1",
          commandId: "delete-2",
        })).entries.find((entry) => entry.status === "trashed")!;
        expect(next.id).not.toBe(first.id);
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect("retains its planned scope after expiration and refuses permanent cleanup", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
      yield* TestClock.setTime(entry.purgeAfter + RETENTION_MS);
      yield* trash.progress(entry.id);
      const snapshot = yield* trash.list;
      expect(snapshot.purgeEnabled).toBe(false);
      expect(snapshot.entries[0]).toMatchObject({
        status: "trashed",
        plannedRemovals: entry.plannedRemovals,
        removals: [],
      });
      const refusal = yield* Effect.flip(trash.empty({ ids: [entry.id] }));
      expect(refusal._tag).toBe("SignalboxTrashError");
      expect(refusal.message).toContain("not available yet");
      expect(f.calls).toEqual([`trash:${entry.id}`]);
    }).pipe(Effect.provide(f.services));
  });

  it.effect("retries interrupted Trash preparation without entering a purge state", () => {
    const f = fixture(false);
    f.setReady(false);
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
      f.setReady(true);
      yield* trash.recover;
      expect((yield* trash.list).entries[0]?.status).toBe("trashed");
      expect(f.calls).toEqual([`trash:${entry.id}`, `trash:${entry.id}`]);
      expect(f.starts).toEqual([entry.id, entry.id]);
      expect((yield* Effect.flip(trash.empty({}))).message).toContain("not available yet");
    }).pipe(Effect.provide(f.services));
  });

  it.effect("does not expose or restore an item after the actor loses its context", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      const entry = (yield* trash.trashFolder({ folderId: FolderId.make("folder-1") })).entries[0]!;
      expect(entry.plannedRemovals).toEqual([
        { _tag: "threadResource", threadId: "nested-thread", resource: "history" },
        { _tag: "threadResource", threadId: "nested-thread", resource: "machine-cache" },
        { _tag: "threadResource", threadId: "nested-thread", resource: "previews" },
        { _tag: "threadResource", threadId: "nested-thread", resource: "attachments" },
        { _tag: "threadResource", threadId: "nested-thread", resource: "automation-runs" },
        { _tag: "driveThreadRefs", driveId: "folder-drive", threadId: "nested-thread" },
        { _tag: "folder", folderId: "folder-1" },
        { _tag: "folder", folderId: "folder-child" },
        { _tag: "note", noteId: "note-1" },
        { _tag: "drive", driveId: "folder-drive", onlyIfUnshared: true },
      ]);
      f.leave();
      expect((yield* trash.list).entries).toEqual([]);
      expect((yield* Effect.flip(trash.restore({ id: entry.id }))).message).toContain(
        "not in your Trash",
      );
    }).pipe(Effect.provide(f.services));
  });

  it.effect(
    "finishes a restore accepted before the deadline after a lost reply and the deadline",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
        yield* TestClock.setTime(entry.purgeAfter - 1);
        f.failNextRestore();
        expect((yield* trash.restore({ id: entry.id })).entries[0]?.status).toBe("restoring");
        yield* TestClock.setTime(entry.purgeAfter + 1);
        yield* trash.recover;
        expect((yield* trash.list).entries[0]?.status).toBe("restored");
        expect((yield* trash.list).entries[0]?.removals).toEqual([]);
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect("recovers interrupted Trash preparation on the user-object alarm", () => {
    const f = fixture();
    f.setReady(false);
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
      f.setReady(true);
      yield* trash.recover;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT scheduled FROM trash_entries WHERE id = ${entry.id}`).toEqual([
        { scheduled: 1 },
      ]);
      expect(f.starts).toEqual([entry.id, entry.id]);
      expect((yield* trash.list).entries[0]?.status).toBe("trashed");
      expect((yield* trash.list).entries[0]?.removals).toEqual([]);
    }).pipe(Effect.provide(f.services));
  });

  it.effect("startup only arms recovery for an unjournaled folder transaction", () => {
    const f = fixture();
    f.setUnjournaledFolders([
      {
        id: "orphan-folder-trash",
        folderId: FolderId.make("folder-orphan"),
        title: "Work",
        contextId: "personal",
        deletedAt: INITIAL,
        purgeAfter: INITIAL + RETENTION_MS,
        targets: [{ threadId: ThreadId.make("nested-thread"), driveId: "folder-drive" }],
        driveIds: ["folder-drive"],
        plannedRemovals: [],
      },
    ]);
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      yield* trash.armRecovery;
      expect(f.calls).toEqual([]);
      expect(f.starts).toEqual([]);
      expect(f.alarms).toEqual([INITIAL + RETRY_MS]);

      yield* trash.recover;
      expect(f.calls).toEqual(["trash:orphan-folder-trash"]);
      expect(f.starts).toEqual(["orphan-folder-trash"]);
      expect((yield* trash.list).entries[0]?.status).toBe("trashed");
    }).pipe(Effect.provide(f.services));
  });

  it.effect(
    "reopens a legacy restore blocked by a parent trashed in the same clock millisecond",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const entry = (yield* trash.trashFolder({ folderId: FolderId.make("folder-1") }))
          .entries[0]!;
        const sql = yield* SqlClient.SqlClient;
        f.setRestorePreflight(entry.id, { status: "trashed", parentTrashedAt: INITIAL });
        yield* sql`UPDATE trash_entries SET status = 'restoring', restore_started_at = ${INITIAL}
        WHERE id = ${entry.id}`;

        const blocked = (yield* trash.restore({ id: entry.id })).entries[0]!;
        expect(blocked).toMatchObject({
          status: "trashed",
          error: "Restore the parent folder first.",
        });
        expect(f.calls).toEqual([`trash:${entry.id}`]);

        f.setRestorePreflight(entry.id, { status: "trashed", parentTrashedAt: null });
        expect((yield* trash.restore({ id: entry.id })).entries[0]?.status).toBe("restored");
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect(
    "keeps a partial restore in progress after its parent is trashed and the deadline passes",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const entry = (yield* trash.trashFolder({ folderId: FolderId.make("folder-1") }))
          .entries[0]!;
        const sql = yield* SqlClient.SqlClient;
        f.setRestorePreflight(entry.id, { status: "restored", parentTrashedAt: INITIAL + 20 });
        yield* sql`UPDATE trash_entries SET status = 'restoring', restore_started_at = ${INITIAL + 10}
          WHERE id = ${entry.id}`;
        yield* TestClock.setTime(entry.purgeAfter + 1);

        const waiting = (yield* trash.restore({ id: entry.id })).entries[0]!;
        expect(waiting).toMatchObject({
          status: "restoring",
          error: "Restore the parent folder first.",
        });
        expect(f.calls).toEqual([`trash:${entry.id}`]);
        expect(f.alarms).toContain(entry.purgeAfter + 1 + RETRY_MS);
      }).pipe(Effect.provide(f.services));
    },
  );
});
