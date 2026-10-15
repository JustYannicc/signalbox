import { CommandId, type ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  type ArchiveChatsAfterDays,
  chatArchiveDueAtMs,
  chatWaitsToArchive,
  effectiveThreadKind,
  type ThreadKindRecord,
} from "@t3tools/contracts/signalboxThreadKinds";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { contextAllows } from "../drive/driveAccess.ts";
import * as ThreadDirectory from "../thread/ThreadDirectory.ts";
import { RecordRow, toRecord } from "./threadKindTables.ts";
import * as UserContexts from "./UserContexts.ts";

/**
 * Idle chats archiving themselves (#46): which are due, archiving them as
 * their owner, and the object's alarm for the next one. `UserThreadKinds`
 * runs it; tasks and threads without a kind never archive themselves.
 */

/** When the user object's alarm goes off. Its only alarm, so it's the sweep's. */
export class ChatArchiveAlarm extends Context.Service<
  ChatArchiveAlarm,
  {
    /**
     * Makes the alarm go off no later than `atMs`. Never clears or postpones
     * one, so a sweep can't undo what a summary armed while it ran.
     */
    readonly armBy: (atMs: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/user/chatArchive/ChatArchiveAlarm") {}

/** No alarm: chats archive only when something sweeps (tests). */
export const layerAlarmNone = Layer.succeed(
  ChatArchiveAlarm,
  ChatArchiveAlarm.of({ armBy: () => Effect.void }),
);

/** A thread with a kind record, as its owner's index last saw it. */
export interface KindedThread {
  readonly record: ThreadKindRecord;
  /** The shell's `updatedAt`: anything that changes the thread moves it. */
  readonly updatedAtMs: number;
  readonly archived: boolean;
  readonly pinned: boolean;
  /** A turn is live: the thread isn't idle. */
  readonly busy: boolean;
}

export interface ArchivePlan {
  /** Idle chats past their time, with the `updatedAt` they were judged at. */
  readonly due: ReadonlyArray<{ readonly threadId: ThreadId; readonly updatedAtMs: number }>;
  /** When the next chat that isn't due yet will be. Null: none will. */
  readonly nextDueAtMs: number | null;
}

/** Which threads are due and when the next is, by the contract's rule (`chatWaitsToArchive`). */
export const archivePlan = (
  threads: ReadonlyArray<KindedThread>,
  days: ArchiveChatsAfterDays,
  nowMs: number,
): ArchivePlan => {
  const due: Array<ArchivePlan["due"][number]> = [];
  let nextDueAtMs: number | null = null;
  for (const thread of threads) {
    if (!chatWaitsToArchive({ ...thread, kind: effectiveThreadKind(thread.record).kind })) continue;
    const dueAt = chatArchiveDueAtMs(thread.updatedAtMs, days);
    if (dueAt === null) continue;
    if (dueAt <= nowMs) {
      due.push({ threadId: thread.record.threadId, updatedAtMs: thread.updatedAtMs });
    } else if (nextDueAtMs === null || dueAt < nextDueAtMs) {
      nextDueAtMs = dueAt;
    }
  }
  return { due, nextDueAtMs };
};

export interface SweepResult {
  readonly archived: ReadonlyArray<ThreadId>;
  readonly nextDueAtMs: number | null;
}

/** A thread whose archive failed for an outage is tried again this much later. */
const RETRY_MS = 60 * 60 * 1000;

const LIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);

const ChatRow = Schema.Struct({
  ...RecordRow.fields,
  context_id: SignalboxContextId,
  updated_at: Schema.String,
  pinned_at: Schema.NullOr(Schema.String),
  active_run_id: Schema.NullOr(Schema.String),
  activity_run_status: Schema.NullOr(Schema.String),
});
const decodeChats = Schema.decodeUnknownSync(Schema.Array(ChatRow));

const minOf = (values: ReadonlyArray<number | null>) => {
  const present = values.filter((value) => value !== null);
  return present.length === 0 ? null : Math.min(...present);
};

/**
 * The sweep for one user's object. `userId`: the object's owner, null before
 * they first sign in; `days`: the user's setting, as stored now.
 */
export const makeChatArchive = (input: {
  readonly userId: Effect.Effect<string | null, SqlError>;
  readonly days: Effect.Effect<ArchiveChatsAfterDays, SqlError>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const contexts = yield* UserContexts.UserContexts;
    const directory = yield* ThreadDirectory.ThreadDirectory;
    const alarm = yield* ChatArchiveAlarm;

    /**
     * Indexed chats that aren't archived or deleted, in any context: the
     * kind the contract's helpers give, spelled in SQL.
     */
    const chats = (threadId?: ThreadId) =>
      Effect.map(
        sql`SELECT k.thread_id, k.classified, k.override, k.work_started_at, i.context_id,
            json_extract(i.shell, '$.updatedAt') AS updated_at,
            json_extract(i.shell, '$.pinnedAt') AS pinned_at,
            json_extract(i.shell, '$.activeRunId') AS active_run_id,
            json_extract(i.shell, '$.activityRunStatus') AS activity_run_status
          FROM thread_kinds k JOIN thread_index i ON i.thread_id = k.thread_id
          WHERE COALESCE(k.override, CASE WHEN k.classified = 'chat' AND k.work_started_at IS NOT NULL
              THEN 'task' ELSE k.classified END) = 'chat'
            AND json_extract(i.shell, '$.archivedAt') IS NULL
            AND json_extract(i.shell, '$.deletedAt') IS NULL
            ${threadId === undefined ? sql`` : sql`AND k.thread_id = ${threadId}`}`,
        decodeChats,
      );

    /** `rows` in the user's current contexts, as the plan reads them. */
    const kinded = (
      rows: ReadonlyArray<typeof ChatRow.Type>,
      contextIds: ReadonlyArray<SignalboxContextId>,
    ) =>
      rows
        .filter((row) => contextAllows(contextIds, row.context_id))
        .map((row): KindedThread => ({
          record: toRecord(row),
          updatedAtMs: Date.parse(row.updated_at),
          archived: false,
          pinned: row.pinned_at !== null,
          busy:
            row.active_run_id !== null ||
            (row.activity_run_status !== null && LIVE_RUN.has(row.activity_run_status)),
        }));

    /** Makes the alarm go off by the time of `threadId`'s chat (or every chat's). */
    const armFor = (threadId?: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* chats(threadId);
        if (rows.length === 0) return;
        const days = yield* input.days;
        if (days === null) return;
        const now = yield* Clock.currentTimeMillis;
        const plan = archivePlan(kinded(rows, yield* contexts.contextIds), days, now);
        const at = plan.due.length > 0 ? now : plan.nextDueAtMs;
        if (at !== null) yield* alarm.armBy(at);
      });

    /** Archives one chat as its owner, if it hasn't changed since the index saw it idle. */
    const archive = (
      actor: { readonly userId: string; readonly contextIds: ReadonlyArray<SignalboxContextId> },
      due: ArchivePlan["due"][number],
    ) =>
      directory
        .forThread(due.threadId)
        .dispatch(
          actor,
          {
            type: "thread.archive",
            // One per idle stretch, so a retry replays its receipt.
            commandId: CommandId.make(`thread-kind-archive:${due.threadId}:${due.updatedAtMs}`),
            threadId: due.threadId,
          },
          { place: null, pools: null, idleSinceMs: due.updatedAtMs },
        )
        .pipe(
          Effect.as("archived" as const),
          Effect.catchTags({
            // It changed since the index saw it: its next summary re-arms.
            ThreadCommandRejectedError: (error) =>
              Effect.as(
                Effect.logInfo("idle chat not archived", {
                  threadId: due.threadId,
                  reason: error.reason,
                }),
                "skipped" as const,
              ),
            ThreadNotFoundError: () => Effect.succeed("skipped" as const),
            ThreadObjectError: (cause) =>
              Effect.as(
                Effect.logWarning("idle chat archive failed; will retry", {
                  threadId: due.threadId,
                  cause,
                }),
                "retry" as const,
              ),
          }),
        );

    /** One sweep at `nowMs`; one thread failing never stops the rest. */
    const run = (nowMs: number) =>
      Effect.gen(function* () {
        const days = yield* input.days;
        const contextIds = yield* contexts.contextIds;
        const plan = archivePlan(kinded(yield* chats(), contextIds), days, nowMs);
        const userId = plan.due.length === 0 ? null : yield* input.userId;
        const outcomes =
          userId === null
            ? []
            : yield* Effect.forEach(plan.due, (due) => archive({ userId, contextIds }, due), {
                concurrency: 4,
              });
        yield* Effect.annotateCurrentSpan({
          "thread_kind.archived": outcomes.filter((outcome) => outcome === "archived").length,
        });
        return {
          days,
          contextIds,
          plan,
          attempted: new Set(plan.due.map((due) => `${due.threadId}:${due.updatedAtMs}`)),
          archived: plan.due
            .filter((_, index) => outcomes[index] === "archived")
            .map((due) => due.threadId),
          retryAt: outcomes.includes("retry") ? nowMs + RETRY_MS : null,
        };
      });

    /** Archives every chat idle past its time as of `nowMs`, and says when the next one is. */
    const sweep = (nowMs: number): Effect.Effect<SweepResult, SqlError> =>
      Effect.map(run(nowMs), (result) => ({
        archived: result.archived,
        nextDueAtMs: minOf([result.plan.nextDueAtMs, result.retryAt]),
      }));

    /**
     * The alarm going off: sweeps now, then arms for what's next as the
     * index stands after the archives went out. Threads this sweep already
     * tried wait for their summaries; anything else that's due goes now.
     */
    const alarmFired = Effect.gen(function* () {
      const result = yield* run(yield* Clock.currentTimeMillis);
      const now = yield* Clock.currentTimeMillis;
      const after = archivePlan(kinded(yield* chats(), result.contextIds), result.days, now);
      const missed = after.due.some(
        (due) => !result.attempted.has(`${due.threadId}:${due.updatedAtMs}`),
      );
      const at = minOf([after.nextDueAtMs, result.retryAt, missed ? now : null]);
      if (at !== null) yield* alarm.armBy(at);
    });

    return { armFor, sweep, alarmFired };
  });
