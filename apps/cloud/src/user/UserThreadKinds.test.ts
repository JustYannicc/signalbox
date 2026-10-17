import { ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
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
 * A user's kinds with a scripted classifier, an alarm that keeps the earliest
 * time it's armed by, and thread objects that record the archives they're
 * sent (`failing` ones are down; `onArchive` runs while one is out).
 */
const setup = (
  options: {
    readonly answer?: ThreadKind | null;
    readonly failing?: string;
    readonly onArchive?: () => void;
  } = {},
) => {
  const asked: Array<KindClassifier.KindQuestion> = [];
  const archived: Array<{
    readonly threadId: string;
    readonly commandId: string;
    readonly idleSinceMs: number | undefined;
  }> = [];
  const alarm: { armedBy: Array<number>; current: number | null } = { armedBy: [], current: null };
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
        dispatch: async (_actor, command, creation) => {
          options.onArchive?.();
          if (threadId === options.failing) throw new Error("object down");
          const { commandId } = command as { readonly commandId: string };
          archived.push({ threadId, commandId, idleSinceMs: creation.idleSinceMs });
          return { _tag: "ok", value: { sequence: 1 } };
        },
        launch: async () => ({ _tag: "not_found" }),
        snapshot: async () => ({ _tag: "not_found" }),
        subscribe: async () => null,
        summary: async () => null,
        diagnostics: async () => null,
        previews: async () => null,
        previewLink: async () => ({ _tag: "unavailable", message: "none" }),
        browserWatch: async () => null,
        browserInput: async () => ({ _tag: "unavailable", message: "none" }),
        browserTrail: async () => ({ _tag: "unavailable", message: "none" }),
        browserStep: async () => ({ _tag: "unavailable", message: "none" }),
        contextMatch: async () => null,
        contextTurns: async () => null,
        setMonitors: async () => ({ _tag: "ok", value: undefined }),
        browsing: async () => null,
        browse: async () => ({ _tag: "not_found" }),
        browsingRecord: async () => ({ _tag: "not_found" }),
      }),
  });
  const recordedAlarm = Layer.succeed(
    ChatArchive.ChatArchiveAlarm,
    ChatArchive.ChatArchiveAlarm.of({
      armBy: (atMs) =>
        Effect.sync(() => {
          alarm.armedBy.push(atMs);
          if (alarm.current === null || alarm.current > atMs) alarm.current = atMs;
        }),
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
    readonly deleted?: boolean;
    readonly pinned?: boolean;
    readonly running?: boolean;
    readonly messaged?: boolean;
    readonly settledAt?: boolean;
    readonly settledOverride?: "settled" | "active";
  },
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => {
    const json = JSON.stringify({
      id: threadId,
      title: "Indexed title",
      updatedAt: iso(shell.updatedAtMs),
      archivedAt: shell.archived === true ? iso(shell.updatedAtMs) : null,
      deletedAt: shell.deleted === true ? iso(shell.updatedAtMs) : null,
      pinnedAt: shell.pinned === true ? iso(shell.updatedAtMs) : null,
      activeRunId: shell.running === true ? "run:1" : null,
      activityRunStatus: shell.running === true ? "running" : null,
      pendingRuntimeRequest: null,
      latestUserMessageAt: shell.messaged === false ? null : iso(shell.updatedAtMs),
      settledAt: shell.settledAt === true ? iso(shell.updatedAtMs) : null,
      settledOverride: shell.settledOverride ?? null,
    });
    return sql`INSERT INTO thread_index (thread_id, context_id, revision, shell, updated_at)
      VALUES (${threadId}, ${PERSONAL_CONTEXT_ID}, 1, ${json}, 0)
      ON CONFLICT (thread_id) DO UPDATE SET shell = excluded.shell`;
  });

const first = (text: string, title?: string) => ({ text, ...(title ? { title } : {}) });
const thread = (id: string) => ThreadId.make(id);

describe("UserThreadKinds", () => {
  it.effect("returns the effective kind and defaults an unknown thread to a task", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      expect(yield* kinds.kindOf(thread("unknown"))).toBe("task");

      yield* indexThread("chat", { updatedAtMs: T0, messaged: false });
      yield* kinds.beforeTurn(thread("chat"), first("What should I call this?"));
      expect(yield* kinds.kindOf(thread("chat"))).toBe("chat");

      yield* kinds.setKind({ threadId: thread("chat"), kind: "task" });
      expect(yield* kinds.kindOf(thread("chat"))).toBe("task");
    }).pipe(Effect.provide(layer));
  });

  it.effect("classifies a thread once, from its first message, and tells its turns", () => {
    const { asked, layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      const chat = kindInstructions("chat");
      yield* indexThread("t1", { updatedAtMs: T0, messaged: false });
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
    const { alarm, layer } = setup();
    return Effect.gen(function* () {
      const { kinds, sql } = yield* services;
      yield* indexThread("t1", { updatedAtMs: T0, messaged: false });
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

      // Setting what's already set stores nothing and arms nothing.
      const rows = () =>
        sql`SELECT thread_id, override, updated_at FROM thread_kinds ORDER BY thread_id`;
      const before = yield* rows();
      const armed = alarm.armedBy.length;
      yield* kinds.setKind({ threadId: thread("t1"), kind: "chat" });
      yield* kinds.setKind({ threadId: thread("t2"), kind: "task" });
      yield* kinds.setKind({ threadId: thread("t3"), kind: "task" });
      yield* kinds.setArchiveChatsAfterDays(7);
      expect(yield* rows()).toEqual(before);
      expect(alarm.armedBy).toHaveLength(armed);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a chat whose turn changed files is a task, once", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* indexThread("t1", { updatedAtMs: T0, messaged: false });
      yield* kinds.beforeTurn(thread("t1"), first("Should we use Postgres?"));
      const started = (atMs: number) =>
        kinds.recordSummary(
          { threadId: thread("t1"), workStartedAt: DateTime.makeUnsafe(atMs) },
          Effect.void,
        );
      yield* started(T0);
      yield* started(T0 + DAY);
      expect((yield* kinds.snapshot).threads[0]?.workStartedAt).toEqual(DateTime.makeUnsafe(T0));
      expect(yield* kinds.beforeTurn(thread("t1"), null)).toEqual(kindInstructions("task"));
      // Flipping it back to a chat is the user's call, and sticks.
      yield* kinds.setKind({ threadId: thread("t1"), kind: "chat" });
      expect(yield* kinds.beforeTurn(thread("t1"), null)).toEqual(kindInstructions("chat"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists only threads clients show, and a chat brought back gets its kind back", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* indexThread("t1", { updatedAtMs: T0, messaged: false });
      yield* kinds.beforeTurn(thread("t1"), first("What's new?"));
      const pull = yield* Stream.toPull(kinds.changes);
      const next = Effect.map(pull, (chunk) => chunk.at(-1)!.threads.map((row) => row.threadId));
      expect(yield* next).toEqual(["t1"]);
      const summary = { threadId: thread("t1") };
      yield* kinds.recordSummary(summary, indexThread("t1", { updatedAtMs: T0, archived: true }));
      expect(yield* next).toEqual([]);
      yield* kinds.recordSummary(summary, indexThread("t1", { updatedAtMs: T0 + DAY }));
      expect(yield* next).toEqual(["t1"]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps kinds for settled archives but not idle archives or deleted threads", () => {
    const { layer } = setup({ answer: "task" });
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      const records: ReadonlyArray<{
        readonly id: string;
        readonly kind: ThreadKind | null;
        readonly flags: Omit<Parameters<typeof indexThread>[1], "updatedAtMs">;
      }> = [
        { id: "settled-chat", kind: "chat", flags: { archived: true, settledAt: true } },
        {
          id: "settled-task",
          kind: null,
          flags: { archived: true, messaged: false, settledOverride: "settled" },
        },
        { id: "idle-archived-chat", kind: "chat", flags: { archived: true } },
        {
          id: "deleted-settled-chat",
          kind: "chat",
          flags: { archived: true, deleted: true, settledAt: true },
        },
      ];
      for (const { id, kind, flags } of records) {
        yield* indexThread(id, { updatedAtMs: T0, ...flags });
        if (kind === null) {
          yield* kinds.beforeTurn(thread(id), first("Fix the bug"));
        } else {
          yield* kinds.setKind({ threadId: thread(id), kind });
        }
      }

      expect((yield* kinds.snapshot).threads).toEqual([
        { threadId: "settled-chat", classified: null, override: "chat", workStartedAt: null },
        { threadId: "settled-task", classified: "task", override: null, workStartedAt: null },
      ]);
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
      // Only if it's still as idle as the index saw it.
      expect(archived).toEqual([
        { threadId: "chat-due", commandId: `thread-kind-archive:chat-due:${T0}`, idleSinceMs: T0 },
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
      // Going off, the alarm is no longer set.
      alarm.current = null;
      yield* kinds.alarm;
      expect(archived.map((entry) => entry.threadId)).toEqual(["chat-due"]);
      expect(alarm.current).toBe(T0 + 8 * DAY);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never lose an alarm a summary armed while the sweep was out", () => {
    const sooner = T0 + 7 * DAY + 60_000;
    // Another chat's summary lands mid-sweep and arms the alarm for itself.
    const { alarm, archived, layer } = setup({ onArchive: () => void (alarm.current = sooner) });
    return Effect.gen(function* () {
      const { kinds } = yield* services;
      yield* seed(kinds);
      yield* TestClock.setTime(T0 + 7 * DAY);
      alarm.current = null;
      yield* kinds.alarm;
      expect(archived.map((entry) => entry.threadId)).toEqual(["chat-due"]);
      expect(alarm.current).toBe(sooner);
    }).pipe(Effect.provide(layer));
  });
});
