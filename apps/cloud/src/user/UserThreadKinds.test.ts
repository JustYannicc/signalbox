import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { layerMemoryStore } from "../testing.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import { kindInstructions } from "../threadKinds/kindInstructions.ts";
import * as KindClassifier from "../threadKinds/KindClassifier.ts";
import * as ChatArchive from "./chatArchive.ts";
import * as UserStore from "./UserStore.ts";
import * as UserThreadKinds from "./UserThreadKinds.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * A user's kinds with a scripted classifier, a recorded alarm, and thread
 * objects that record the archives they're sent (`failing` ones are down).
 */
const setup = (
  options: { readonly answer?: ThreadKind | null; readonly failing?: string } = {},
) => {
  const asked: Array<KindClassifier.KindQuestion> = [];
  const archived: Array<{ readonly threadId: string; readonly commandId: string }> = [];
  const alarm: { armedBy: Array<number>; reset: Array<number | null> } = {
    armedBy: [],
    reset: [],
  };
  const classifier = Layer.succeed(
    KindClassifier.KindClassifier,
    KindClassifier.KindClassifier.of({
      classify: (question) =>
        Effect.sync(() => {
          asked.push(question);
          return Option.fromNullishOr(options.answer === undefined ? "chat" : options.answer);
        }),
    }),
  );
  const directory = Layer.succeed(ThreadDirectory.ThreadDirectory, {
    forThread: (threadId) =>
      ThreadDirectory.handleFor({
        dispatch: async (_actor, command) => {
          if (threadId === options.failing) throw new Error("object down");
          const { commandId } = command as { readonly commandId: string };
          archived.push({ threadId, commandId });
          return { _tag: "ok", value: { sequence: 1 } };
        },
        launch: async () => ({ _tag: "not_found" }),
        snapshot: async () => ({ _tag: "not_found" }),
        subscribe: async () => null,
        summary: async () => null,
        diagnostics: async () => null,
        previews: async () => null,
        previewLink: async () => ({ _tag: "unavailable", message: "none" }),
        contextMatch: async () => null,
        contextTurns: async () => null,
      }),
  });
  const recordedAlarm = Layer.succeed(
    ChatArchive.ChatArchiveAlarm,
    ChatArchive.ChatArchiveAlarm.of({
      armBy: (atMs) => Effect.sync(() => void alarm.armedBy.push(atMs)),
      reset: (atMs) => Effect.sync(() => void alarm.reset.push(atMs)),
    }),
  );
  const layer = UserThreadKinds.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(classifier, directory, recordedAlarm)),
    Layer.provideMerge(layerMemoryStore),
  );
  return { asked, archived, alarm, layer };
};

const services = Effect.gen(function* () {
  const store = yield* UserStore.UserStore;
  yield* store.recordSignIn({ id: "user_1", email: "ada@example.com" });
  return { kinds: yield* UserThreadKinds.UserThreadKinds, sql: yield* SqlClient.SqlClient };
});

/** A thread's row in the index, as its summary would leave it; only what kinds read. */
const indexThread = (
  threadId: string,
  shell: {
    readonly updatedAtMs: number;
    readonly archived?: boolean;
    readonly pinned?: boolean;
    readonly running?: boolean;
    readonly messaged?: boolean;
  },
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const json = JSON.stringify({
      id: threadId,
      title: "Indexed title",
      updatedAt: iso(shell.updatedAtMs),
      archivedAt: shell.archived === true ? iso(shell.updatedAtMs) : null,
      deletedAt: null,
      pinnedAt: shell.pinned === true ? iso(shell.updatedAtMs) : null,
      activeRunId: shell.running === true ? "run:1" : null,
      activityRunStatus: shell.running === true ? "running" : null,
      pendingRuntimeRequest: null,
      latestUserMessageAt: shell.messaged === false ? null : iso(shell.updatedAtMs),
    });
    return sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
      VALUES (${threadId}, ${PERSONAL_CONTEXT_ID}, 1, ${json}, 0)
      ON CONFLICT (thread_id) DO UPDATE SET shell = excluded.shell`;
  });

const first = (text: string, title?: string) => ({ text, ...(title ? { title } : {}) });
const thread = (id: string) => ThreadId.make(id);

describe("UserThreadKinds", () => {
  it.effect("classifies a thread once, from its first message, and tells its turns", () => {
    const { asked, layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      const chat = kindInstructions("chat");
      expect(
        yield* kinds.beforeTurn(thread("t1"), first("How do refunds work?", "Refunds")),
      ).toEqual(chat);
      expect(asked).toEqual([{ title: "Refunds", firstMessage: "How do refunds work?" }]);
      // Later messages and model changes keep the kind without asking again.
      expect(yield* kinds.beforeTurn(thread("t1"), first("Now fix the bug"))).toEqual(chat);
      expect(yield* kinds.beforeTurn(thread("t1"), null)).toEqual(chat);
      expect(asked).toHaveLength(1);
      expect((yield* kinds.snapshot).threads).toEqual([
        { threadId: "t1", classified: "chat", override: null, workStartedAt: null },
      ]);

      // A thread whose index shows a message is from before: it stays a task, unasked.
      yield* indexThread("old", { updatedAtMs: T0 });
      expect(yield* kinds.beforeTurn(thread("old"), first("More"))).toBeNull();
      // A first message titled by the thread itself, when the command names none.
      yield* indexThread("t2", { updatedAtMs: T0, messaged: false });
      yield* kinds.beforeTurn(thread("t2"), first("Draft the launch email"));
      expect(asked.at(-1)).toEqual({
        title: "Indexed title",
        firstMessage: "Draft the launch email",
      });
      expect(asked).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("tells unknown threads nothing when the classifier has no answer", () => {
    const { layer } = setup({ answer: null });
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      expect(yield* kinds.beforeTurn(thread("t1"), first("Hi"))).toBeNull();
      expect((yield* kinds.snapshot).threads).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the user's flip wins, and flipping back to what it is drops it", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* kinds.beforeTurn(thread("t1"), first("What is X?"));
      const flipped = yield* kinds.setKind({ threadId: thread("t1"), kind: "task" });
      expect(flipped.threads[0]).toMatchObject({ classified: "chat", override: "task" });
      expect(yield* kinds.beforeTurn(thread("t1"), null)).toEqual(kindInstructions("task"));
      const back = yield* kinds.setKind({ threadId: thread("t1"), kind: "chat" });
      expect(back.threads[0]).toMatchObject({ classified: "chat", override: null });

      // A thread nobody classified is a task: making it one again is no flip at all.
      yield* kinds.setKind({ threadId: thread("t2"), kind: "chat" });
      expect(yield* kinds.beforeTurn(thread("t2"), null)).toEqual(kindInstructions("chat"));
      yield* kinds.setKind({ threadId: thread("t2"), kind: "task" });
      expect(yield* kinds.beforeTurn(thread("t2"), null)).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a chat whose turn changed files is a task, once", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* kinds.beforeTurn(thread("t1"), first("Should we use Postgres?"));
      yield* kinds.workStarted(thread("t1"), T0);
      yield* kinds.workStarted(thread("t1"), T0 + DAY);
      expect((yield* kinds.snapshot).threads[0]?.workStartedAt).toEqual(DateTime.makeUnsafe(T0));
      expect(yield* kinds.beforeTurn(thread("t1"), null)).toEqual(kindInstructions("task"));
      // Flipping it back to a chat is the user's call, and sticks.
      yield* kinds.setKind({ threadId: thread("t1"), kind: "chat" });
      expect(yield* kinds.beforeTurn(thread("t1"), null)).toEqual(kindInstructions("chat"));
    }).pipe(Effect.provide(layer));
  });
});

describe("idle chats", () => {
  /** Indexed threads, each flipped to its kind (none for unknown ones). */
  const seed = (kinds: UserThreadKinds.UserThreadKinds["Service"]) =>
    Effect.gen(function* () {
      const threads: Array<[string, ThreadKind | null, Parameters<typeof indexThread>[1]]> = [
        ["chat-due", "chat", { updatedAtMs: T0 }],
        ["chat-later", "chat", { updatedAtMs: T0 + DAY }],
        ["task-due", "task", { updatedAtMs: T0 }],
        ["chat-pinned", "chat", { updatedAtMs: T0, pinned: true }],
        ["chat-running", "chat", { updatedAtMs: T0, running: true }],
        ["chat-archived", "chat", { updatedAtMs: T0, archived: true }],
        ["unknown-due", null, { updatedAtMs: T0 }],
      ];
      for (const [id, kind, shell] of threads) {
        yield* indexThread(id, shell);
        if (kind !== null) yield* kinds.setKind({ threadId: thread(id), kind });
      }
    });

  it.effect("archive themselves once idle past their time; nothing else does", () => {
    const { archived, layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* seed(kinds);
      expect(yield* kinds.sweep(T0 + 7 * DAY - 1)).toEqual({
        archived: [],
        nextDueAtMs: T0 + 7 * DAY,
      });
      expect(yield* kinds.sweep(T0 + 7 * DAY)).toEqual({
        archived: ["chat-due"],
        nextDueAtMs: T0 + 8 * DAY,
      });
      expect(archived).toEqual([
        { threadId: "chat-due", commandId: `thread-kind-archive:chat-due:${T0}` },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("wait their full time again once brought back", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* kinds.setKind({ threadId: thread("c"), kind: "chat" });
      yield* indexThread("c", { updatedAtMs: T0, archived: true });
      // Brought back eight days later: unarchiving moved its `updatedAt`.
      yield* indexThread("c", { updatedAtMs: T0 + 8 * DAY });
      expect(yield* kinds.sweep(T0 + 8 * DAY)).toEqual({
        archived: [],
        nextDueAtMs: T0 + 15 * DAY,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("never archive when the user turned it off", () => {
    const { archived, layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* seed(kinds);
      const off = yield* kinds.setArchiveChatsAfterDays(null);
      expect(off.archiveChatsAfterDays).toBeNull();
      expect(yield* kinds.sweep(T0 + 365 * DAY)).toEqual({ archived: [], nextDueAtMs: null });
      expect(archived).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keep going past a thread that fails, and try it again later", () => {
    const { archived, layer } = setup({ failing: "a" });
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      for (const id of ["a", "b"]) {
        yield* kinds.setKind({ threadId: thread(id), kind: "chat" });
        yield* indexThread(id, { updatedAtMs: T0 });
      }
      const now = T0 + 30 * DAY;
      expect(yield* kinds.sweep(now)).toEqual({ archived: ["b"], nextDueAtMs: now + 60 * 60_000 });
      expect(archived.map((entry) => entry.threadId)).toEqual(["b"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("are swept by the alarm, which is armed for the next one", () => {
    const { alarm, archived, layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* TestClock.setTime(T0);
      yield* seed(kinds);
      // Every change arms the alarm by its chat's time.
      expect(Math.min(...alarm.armedBy)).toBe(T0 + 7 * DAY);
      yield* TestClock.setTime(T0 + 7 * DAY);
      yield* kinds.alarm;
      expect(archived.map((entry) => entry.threadId)).toEqual(["chat-due"]);
      expect(alarm.reset).toEqual([T0 + 8 * DAY]);
    }).pipe(Effect.provide(layer));
  });
});
