import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";
import type { ThreadId } from "@t3tools/contracts";
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

import type { ThreadSummary } from "../thread/ThreadEngine.ts";
import { ThreadKindTurns } from "../thread/ThreadKindTurns.ts";
import { kindInstructions } from "../threadKinds/kindInstructions.ts";
import { KindClassifier } from "../threadKinds/KindClassifier.ts";
import { makeChatArchive, type SweepResult } from "./chatArchive.ts";
import { makeProfileId } from "./profileId.ts";
import { decodeRecords, toRecord } from "./threadKindTables.ts";

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
    /** A turn first changed the thread's files at `atMs`: a chat that did is a task now. */
    readonly workStarted: (threadId: ThreadId, atMs: number) => Effect.Effect<void, SqlError>;
    /** After the index took a summary: when work started, and when the thread archives. */
    readonly summaryRecorded: (summary: ThreadSummary) => Effect.Effect<void, SqlError>;
    /** Archives every chat idle past its time as of `nowMs`, and says when the next one is. */
    readonly sweep: (nowMs: number) => Effect.Effect<SweepResult, SqlError>;
    /** The alarm: sweeps now and sets the alarm for the next one. */
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

/** Whether anything set the thread's kind: unknown threads get no instruction. */
const known = (record: ThreadKindRecord | undefined): record is ThreadKindRecord =>
  record !== undefined && (record.classified !== null || record.override !== null);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const classifier = yield* KindClassifier;
  const userId = yield* makeProfileId;
  const changed = yield* PubSub.sliding<void>(1);
  const announce = PubSub.publish(changed, undefined);

  /** A span with who acted and on which thread (#284): ids only, never a message. */
  const traced =
    (name: string, attributes: Readonly<Record<string, string | number | null>>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(userId.pipe(Effect.orElseSucceed(() => null)), (person) =>
        effect.pipe(
          Effect.withSpan(name, {
            attributes: Object.fromEntries(
              Object.entries({ "person.id": person, ...attributes }).filter(
                ([, value]) => value !== null,
              ),
            ),
          }),
        ),
      );

  const recordOf = (threadId: ThreadId) =>
    Effect.map(
      sql`SELECT thread_id, classified, override, work_started_at FROM thread_kinds
        WHERE thread_id = ${threadId}`,
      (rows) => decodeRecords(rows).map(toRecord)[0],
    );

  const days = Effect.map(
    sql`SELECT archive_chats_after_days FROM thread_kind_settings WHERE id = 1`,
    (rows) => decodeDays(rows)[0]?.archive_chats_after_days ?? null,
  );

  const snapshot: UserThreadKinds["Service"]["snapshot"] = Effect.all({
    threads: Effect.map(
      sql`SELECT thread_id, classified, override, work_started_at FROM thread_kinds
        ORDER BY thread_id`,
      (rows) => decodeRecords(rows).map(toRecord),
    ),
    archiveChatsAfterDays: days,
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
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const override = overrideFor(yield* recordOf(input.threadId), input.kind);
          yield* sql`INSERT INTO thread_kinds (thread_id, override, updated_at)
            VALUES (${input.threadId}, ${override}, ${now})
            ON CONFLICT (thread_id) DO UPDATE SET override = excluded.override,
              updated_at = excluded.updated_at`;
        }),
      );
      yield* announce;
      yield* armFor(input.threadId);
      return yield* snapshot;
    }).pipe(traced("signalbox.thread_kind.set", { "thread.id": input.threadId, kind: input.kind }));

  const setArchiveChatsAfterDays: UserThreadKinds["Service"]["setArchiveChatsAfterDays"] = (
    value,
  ) =>
    Effect.gen(function* () {
      yield* sql`UPDATE thread_kind_settings SET archive_chats_after_days = ${value} WHERE id = 1`;
      yield* announce;
      yield* armFor();
      return yield* snapshot;
    }).pipe(traced("signalbox.thread_kind.set_archive_days", { days: value }));

  /**
   * The thread's first message, classified once: only a thread nobody gave a
   * kind, before its index row shows a message. Threads from before #46 have
   * messages, so they stay tasks.
   */
  const classifyFirst = (
    threadId: ThreadId,
    message: { readonly text: string; readonly title?: string | undefined },
  ) =>
    Effect.gen(function* () {
      const [indexed] = decodeIndexed(
        yield* sql`SELECT json_extract(shell, '$.title') AS title,
            json_extract(shell, '$.latestUserMessageAt') AS latest
          FROM thread_index WHERE thread_id = ${threadId}`,
      );
      if (indexed !== undefined && indexed.latest !== null) return;
      const kind = yield* classifier.classify({
        title: message.title ?? indexed?.title ?? "",
        firstMessage: message.text,
      });
      if (Option.isNone(kind)) return;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO thread_kinds (thread_id, classified, updated_at)
        VALUES (${threadId}, ${kind.value}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET classified = excluded.classified,
          updated_at = excluded.updated_at
        WHERE thread_kinds.classified IS NULL AND thread_kinds.override IS NULL`;
      yield* announce;
    }).pipe(traced("signalbox.thread_kind.classify_first", { "thread.id": threadId }));

  const beforeTurn: UserThreadKinds["Service"]["beforeTurn"] = (threadId, message) =>
    Effect.gen(function* () {
      let record = yield* recordOf(threadId);
      if (message !== null && !known(record)) {
        yield* classifyFirst(threadId, message);
        record = yield* recordOf(threadId);
      }
      return known(record) ? kindInstructions(effectiveThreadKind(record).kind) : null;
    }).pipe(
      // The kind's line is a hint: a storage failure sends the turn without it.
      Effect.catch((cause) =>
        Effect.as(
          Effect.logError("thread kind lookup failed", { threadId, cause }),
          null as FolderInstructions | null,
        ),
      ),
    );

  // Only threads with a kind keep it: any other is a task already.
  const workStarted: UserThreadKinds["Service"]["workStarted"] = (threadId, atMs) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const started =
        yield* sql`UPDATE thread_kinds SET work_started_at = ${atMs}, updated_at = ${now}
        WHERE thread_id = ${threadId} AND work_started_at IS NULL RETURNING thread_id`;
      if (started.length > 0) yield* announce;
    });

  const summaryRecorded: UserThreadKinds["Service"]["summaryRecorded"] = (summary) =>
    Effect.gen(function* () {
      if (summary.workStartedAt !== undefined) {
        yield* workStarted(summary.threadId, DateTime.toEpochMillis(summary.workStartedAt));
      }
      yield* armFor(summary.threadId);
    });

  return UserThreadKinds.of({
    snapshot,
    changes,
    setKind,
    setArchiveChatsAfterDays,
    beforeTurn,
    workStarted,
    summaryRecorded,
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
