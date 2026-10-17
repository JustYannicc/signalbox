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
import { TrashResources } from "./TrashResources.ts";
import { TrashAlarm, TrashWorkflow } from "./TrashWorkflow.ts";
import { RETENTION_MS } from "./trashTables.ts";
import { UserTrash, layer } from "./UserTrash.ts";

const INITIAL = 1_000_000;

const fixture = (enabled = true) => {
  const calls: string[] = [];
  const starts: string[] = [];
  let failPurge = true;
  let ready = true;
  let failRestore = false;
  let failStart = false;
  let contextIds: ReadonlyArray<SignalboxContextId> = [PERSONAL_CONTEXT_ID];
  const resources = Layer.succeed(TrashResources, {
    describeThread: (_actor, threadId) =>
      Effect.succeed({
        title: "A thread",
        contextId: "personal",
        target: { threadId, driveId: "my/personal/u1" },
      }),
    trashFolder: (_actor, folderId) =>
      Effect.succeed({
        id: "folder-trash-1",
        folderId,
        title: "Work",
        contextId: "personal",
        deletedAt: INITIAL,
        purgeAfter: INITIAL + RETENTION_MS,
        targets: [],
        driveIds: [],
      }),
    folderTrashes: () => Effect.succeed([]),
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
    purge: (_actor, row) =>
      Effect.suspend(() => {
        calls.push(`purge:${row.id}`);
        if (failPurge) {
          failPurge = false;
          return Effect.fail(new SignalboxTrashError({ message: "Storage is unavailable." }));
        }
        return Effect.succeed([{ kind: "thread", id: row.target_id }]);
      }),
    collect: (_actor, row) =>
      Effect.sync(() => {
        calls.push(`gc:${row.id}`);
        return [{ kind: "drive-pack", id: "private-pack" }];
      }),
  });
  const services = layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        resources,
        Layer.succeed(TrashAlarm, { armBy: () => Effect.void }),
        Layer.succeed(TrashWorkflow, {
          enabled,
          start: (_user, id) =>
            Effect.suspend(() => {
              starts.push(id);
              return failStart
                ? Effect.fail(new SignalboxTrashError({ message: "Workflow launch failed." }))
                : Effect.void;
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
    setReady: (value: boolean) => {
      ready = value;
    },
    failNextRestore: () => {
      failRestore = true;
    },
    setStartFailure: (value: boolean) => {
      failStart = value;
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
        expect((yield* trash.trashThread({ threadId: "thread-1" })).entries).toHaveLength(1);
        expect((yield* trash.restore({ id: first.id })).entries[0]?.status).toBe("restored");
        yield* trash.restore({ id: first.id });
        expect(f.calls.filter((call) => call.startsWith("restore:"))).toHaveLength(1);
        const second = (yield* trash.trashThread({ threadId: "thread-1" })).entries.find(
          (row) => row.status === "trashed",
        )!;
        expect(second.id).not.toBe(first.id);
        expect((yield* trash.progress(first.id)).done).toBe(true);
        expect(f.calls.some((call) => call.startsWith("purge:"))).toBe(false);
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect(
    "retries purge after the window, records removals once and collects packs after their grace",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
        expect((yield* trash.progress(entry.id)).nextAt).toBe(entry.purgeAfter);
        yield* TestClock.setTime(entry.purgeAfter);
        yield* trash.progress(entry.id);
        expect((yield* trash.list).entries[0]).toMatchObject({
          status: "purging",
          error: "Storage is unavailable.",
        });
        expect((yield* trash.progress(entry.id)).done).toBe(false);
        expect((yield* trash.list).entries[0]).toMatchObject({
          status: "purged",
          removals: [{ kind: "thread", id: "thread-1" }],
        });
        yield* trash.progress(entry.id);
        expect(f.calls.filter((call) => call.startsWith("purge:"))).toHaveLength(2);
        yield* TestClock.setTime(entry.purgeAfter + RETENTION_MS);
        expect((yield* trash.progress(entry.id)).done).toBe(true);
        expect((yield* trash.progress(entry.id)).done).toBe(true);
        expect(f.calls.filter((call) => call.startsWith("gc:"))).toHaveLength(1);
        expect((yield* trash.list).entries[0]?.removals).toEqual([
          { kind: "thread", id: "thread-1" },
          { kind: "drive-pack", id: "private-pack" },
        ]);
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect(
    "does not purge until saving is confirmed and the default-off switch is enabled",
    () => {
      const f = fixture(false);
      f.setReady(false);
      return Effect.gen(function* () {
        const trash = yield* f.initialize;
        const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
        yield* TestClock.setTime(entry.purgeAfter + 1);
        yield* trash.progress(entry.id);
        f.setReady(true);
        yield* trash.progress(entry.id);
        expect((yield* trash.list).entries[0]?.status).toBe("trashed");
        expect(f.calls.some((call) => call.startsWith("purge:"))).toBe(false);
        expect((yield* Effect.flip(trash.empty({}))).message).toContain("not been enabled");
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect("does not start purge or expose an item after the actor loses its context", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      const entry = (yield* trash.trashFolder({ folderId: FolderId.make("folder-1") })).entries[0]!;
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
        expect(f.calls.some((call) => call.startsWith("purge:"))).toBe(false);
      }).pipe(Effect.provide(f.services));
    },
  );

  it.effect("recovers a journaled deletion whose Workflow launch never landed", () => {
    const f = fixture();
    f.setStartFailure(true);
    return Effect.gen(function* () {
      const trash = yield* f.initialize;
      const entry = (yield* trash.trashThread({ threadId: "thread-1" })).entries[0]!;
      f.setStartFailure(false);
      yield* trash.recover;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT scheduled FROM trash_entries WHERE id = ${entry.id}`).toEqual([
        { scheduled: 1 },
      ]);
      expect(f.starts).toEqual([entry.id, entry.id]);
      expect((yield* trash.list).entries[0]?.status).toBe("trashed");
    }).pipe(Effect.provide(f.services));
  });
});
