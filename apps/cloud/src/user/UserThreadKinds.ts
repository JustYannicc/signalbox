import type { ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  ArchiveChatsAfterDays,
  effectiveThreadKind,
  overrideFor,
  type SignalboxThreadKindsSnapshot,
  type ThreadKindRecord,
  type ThreadKindSetInput,
} from "@t3tools/contracts/signalboxThreadKinds";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { contextAllows } from "../drive/driveAccess.ts";
import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import { ThreadKindTurns } from "../thread/ThreadKindTurns.ts";
import { kindInstructions } from "../threadKinds/kindInstructions.ts";
import { KindClassifier } from "../threadKinds/KindClassifier.ts";
import { makeChatArchive, type SweepResult } from "./chatArchive.ts";
import { makeProfileId } from "./profileId.ts";
import { decodeRecords, RecordRow, toRecord } from "./threadKindTables.ts";
import { makeTraced } from "./tracing.ts";
import * as UserContexts from "./UserContexts.ts";

/**
 * Whether each of the user's threads is a chat or a task (#46), in their own
 * object (`threadKindTables.ts`). The classifier sets a thread's kind from
 * its first message, a summary saying a turn changed files turns a chat into
 * a task, and the user's flip wins over both (the contract's helpers decide
 * which). Idle chats archive themselves on the object's alarm
 * (`chatArchive.ts`).
 */

export class UserThreadKinds extends Context.Service<
  UserThreadKinds,
  {
    /** Kinds of the threads clients list: in the user's contexts, not archived or deleted. */
    readonly snapshot: Effect.Effect<SignalboxThreadKindsSnapshot, SqlError>;
    /** The snapshot now, then again after every change. */
    readonly changes: Stream.Stream<SignalboxThreadKindsSnapshot, SqlError>;
    readonly setKind: (
      input: ThreadKindSetInput,
    ) => Effect.Effect<SignalboxThreadKindsSnapshot, SqlError>;
    readonly setArchiveChatsAfterDays: (
      days: ArchiveChatsAfterDays,
    ) => Effect.Effect<SignalboxThreadKindsSnapshot, SqlError>;
    /** See `ThreadKindTurns.beforeTurn`. */
    readonly beforeTurn: ThreadKindTurns["Service"]["beforeTurn"];
    /**
     * Indexes a thread's summary with `index`, then takes what it says: when
     * a turn first changed files, whether the thread left or rejoined the
     * list, and when it archives.
     */
    readonly recordSummary: <E, R>(
      summary: Pick<ThreadSummary, "threadId" | "workStartedAt">,
      index: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<void, E | SqlError, R>;
    /** Archives every chat idle past its time as of `nowMs`, and says when the next one is. */
    readonly sweep: (nowMs: number) => Effect.Effect<SweepResult, SqlError>;
    /** The alarm: sweeps now and arms the alarm for the next one. */
    readonly alarm: Effect.Effect<void, SqlError>;
    /** Makes sure the alarm goes off by the next chat's time, on the object's start. */
    readonly arm: Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/user/UserThreadKinds") {}

const decodeDays = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ archive_chats_after_days: ArchiveChatsAfterDays })),
);
const decodeIndexed = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ title: Schema.NullOr(Schema.String), latest: Schema.NullOr(Schema.String) }),
  ),
);
const decodeListed = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ ...RecordRow.fields, context_id: SignalboxContextId })),
);

/** Whether anything set the thread's kind: unknown threads get no instruction. */
const known = (record: ThreadKindRecord | undefined): record is ThreadKindRecord =>
  record !== undefined && (record.classified !== null || record.override !== null);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const classifier = yield* KindClassifier;
  const contexts = yield* UserContexts.UserContexts;
  const userId = yield* makeProfileId;
  /** Spans never carry a message or title (`tracing.ts`). */
  const traced = makeTraced(userId);
  const changed = yield* PubSub.sliding<void>(1);
  const announce = PubSub.publish(changed, undefined);
  // Leaving or joining a context changes which threads are listed.
  yield* contexts.contextsChanged.pipe(
    Stream.runForEach(() => announce),
    Effect.forkScoped,
  );

  const selectRecords = sql`SELECT k.thread_id, k.classified, k.override, k.work_started_at
    FROM thread_kinds k`;

  const recordOf = (threadId: ThreadId) =>
    Effect.map(
      sql`${selectRecords} WHERE k.thread_id = ${threadId}`,
      (rows) => decodeRecords(rows).map(toRecord)[0],
    );

  const days = Effect.map(
    sql`SELECT archive_chats_after_days FROM thread_kind_settings WHERE id = 1`,
    (rows) => decodeDays(rows)[0]?.archive_chats_after_days ?? null,
  );

  /** Whether clients list the thread: indexed, and neither archived nor deleted. */
  const listedClause = sql`json_extract(i.shell, '$.archivedAt') IS NULL
    AND json_extract(i.shell, '$.deletedAt') IS NULL`;

  const isListed = (threadId: ThreadId) =>
    Effect.map(
      sql`SELECT 1 AS listed FROM thread_index i WHERE i.thread_id = ${threadId} AND ${listedClause}`,
      (rows) => rows.length > 0,
    );

  const snapshot: UserThreadKinds["Service"]["snapshot"] = Effect.gen(function* () {
    const rows = decodeListed(
      yield* sql`SELECT k.thread_id, k.classified, k.override, k.work_started_at, i.context_id
        FROM thread_kinds k JOIN thread_index i ON i.thread_id = k.thread_id
        WHERE ${listedClause} ORDER BY k.thread_id`,
    );
    const ids = rows.length === 0 ? [] : yield* contexts.contextIds;
    return {
      threads: rows.filter((row) => contextAllows(ids, row.context_id)).map(toRecord),
      archiveChatsAfterDays: yield* days,
    };
  });

  const changes: UserThreadKinds["Service"]["changes"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.prepend([undefined]),
        Stream.mapEffect(() => snapshot),
      ),
    ),
  );

  const { armFor, sweep, alarmFired } = yield* makeChatArchive({ userId, days });

  const setKind: UserThreadKinds["Service"]["setKind"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const wrote = yield* sql.withTransaction(
        Effect.gen(function* () {
          const record = yield* recordOf(input.threadId);
          const override = overrideFor(record, input.kind);
          // Already that kind: nothing to store, and no row for a thread nobody gave one.
          if (record === undefined ? override === null : record.override === override) {
            return false;
          }
          yield* sql`INSERT INTO thread_kinds (thread_id, override, updated_at)
            VALUES (${input.threadId}, ${override}, ${now})
            ON CONFLICT (thread_id) DO UPDATE SET override = excluded.override,
              updated_at = excluded.updated_at`;
          return true;
        }),
      );
      if (wrote) {
        yield* announce;
        yield* armFor(input.threadId);
      }
      return yield* snapshot;
    }).pipe(traced("signalbox.thread_kind.set", { "thread.id": input.threadId, kind: input.kind }));

  const setArchiveChatsAfterDays: UserThreadKinds["Service"]["setArchiveChatsAfterDays"] = (
    value,
  ) =>
    Effect.gen(function* () {
      if ((yield* days) !== value) {
        yield* sql`UPDATE thread_kind_settings SET archive_chats_after_days = ${value} WHERE id = 1`;
        yield* announce;
        yield* armFor();
      }
      return yield* snapshot;
    }).pipe(traced("signalbox.thread_kind.set_archive_days", { days: value }));

  /**
   * The thread's first message, classified once: only a thread nobody gave a
   * kind, before its index row shows a message. Threads from before #46 have
   * messages, so they stay tasks. Returns the record as it is now.
   */
  const classifyFirst = (
    threadId: ThreadId,
    message: { readonly text: string; readonly title?: string | undefined },
    record: ThreadKindRecord | undefined,
  ) =>
    Effect.gen(function* () {
      const [indexed] = decodeIndexed(
        yield* sql`SELECT json_extract(shell, '$.title') AS title,
            json_extract(shell, '$.latestUserMessageAt') AS latest
          FROM thread_index WHERE thread_id = ${threadId}`,
      );
      if (indexed !== undefined && indexed.latest !== null) return record;
      const kind = yield* classifier.classify({
        title: message.title ?? indexed?.title ?? "",
        firstMessage: message.text,
      });
      if (Option.isNone(kind)) return record;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO thread_kinds (thread_id, classified, updated_at)
        VALUES (${threadId}, ${kind.value}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET classified = excluded.classified,
          updated_at = excluded.updated_at
        WHERE thread_kinds.classified IS NULL AND thread_kinds.override IS NULL`;
      yield* announce;
      return {
        threadId,
        classified: kind.value,
        override: null,
        workStartedAt: record?.workStartedAt ?? null,
      } satisfies ThreadKindRecord;
    }).pipe(traced("signalbox.thread_kind.classify_first", { "thread.id": threadId }));

  const beforeTurn: UserThreadKinds["Service"]["beforeTurn"] = (threadId, message) =>
    Effect.gen(function* () {
      const stored = yield* recordOf(threadId);
      const record =
        message !== null && !known(stored)
          ? yield* classifyFirst(threadId, message, stored)
          : stored;
      return known(record) ? kindInstructions(effectiveThreadKind(record).kind) : null;
    }).pipe(
      // The kind's line is a hint: a storage failure sends the turn without it.
      Effect.catch((cause) =>
        Effect.as(Effect.logError("thread kind lookup failed", { threadId, cause }), null),
      ),
    );

  const recordSummary: UserThreadKinds["Service"]["recordSummary"] = (summary, index) =>
    Effect.gen(function* () {
      const record = yield* recordOf(summary.threadId);
      // Any other thread is a task: nothing about it is the kinds' business.
      if (record === undefined) {
        yield* index;
        return;
      }
      const listedBefore = yield* isListed(summary.threadId);
      yield* index;
      // Archived or brought back: it leaves the list or gets its kind back.
      let changedAnything = listedBefore !== (yield* isListed(summary.threadId));
      if (summary.workStartedAt !== undefined && record.workStartedAt === null) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE thread_kinds
          SET work_started_at = ${DateTime.toEpochMillis(summary.workStartedAt)}, updated_at = ${now}
          WHERE thread_id = ${summary.threadId} AND work_started_at IS NULL`;
        changedAnything = true;
      }
      if (changedAnything) yield* announce;
      yield* armFor(summary.threadId);
    });

  return UserThreadKinds.of({
    snapshot,
    changes,
    setKind,
    setArchiveChatsAfterDays,
    beforeTurn,
    recordSummary,
    sweep: (nowMs) => sweep(nowMs).pipe(traced("signalbox.thread_kind.sweep", {})),
    alarm: alarmFired.pipe(traced("signalbox.thread_kind.sweep", {})),
    arm: armFor(),
  });
});

export const layer = Layer.effect(UserThreadKinds, make);

/** `CloudThreadService`'s view of kinds, in the user's object. */
export const layerTurns = Layer.effect(
  ThreadKindTurns,
  Effect.gen(function* () {
    const kinds = yield* UserThreadKinds;
    return ThreadKindTurns.of({ beforeTurn: kinds.beforeTurn });
  }),
);
