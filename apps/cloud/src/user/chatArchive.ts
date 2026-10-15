import { CommandId, type ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  type ArchiveChatsAfterDays,
  chatArchiveDueAtMs,
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
    /** Makes the alarm go off no later than `atMs`. */
    readonly armBy: (atMs: number) => Effect.Effect<void>;
    /** Sets the alarm to `atMs` after a sweep, or clears it for null. */
    readonly reset: (atMs: number | null) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/user/chatArchive/ChatArchiveAlarm") {}

/** No alarm: chats archive only when something sweeps (tests). */
export const layerAlarmNone = Layer.succeed(
  ChatArchiveAlarm,
  ChatArchiveAlarm.of({ armBy: () => Effect.void, reset: () => Effect.void }),
);

/** A thread with a kind record, as its owner's index last saw it. */
export interface KindedThread {
  readonly record: ThreadKindRecord;
  /** The shell's `updatedAt`: anything that changes the thread moves it. */
  readonly updatedAtMs: number;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly pinned: boolean;
  /** A turn is live or waiting on someone: it isn't idle. */
  readonly busy: boolean;
}

export interface ArchivePlan {
  /** Idle chats past their time, with the `updatedAt` they were judged at. */
  readonly due: ReadonlyArray<{ readonly threadId: ThreadId; readonly updatedAtMs: number }>;
  /** When the next chat that isn't due yet will be. Null: none will. */
  readonly nextDueAtMs: number | null;
}

/**
 * Only chats wait to archive. A pinned chat, or one busy with a turn, isn't
 * idle; it's judged again once its summary says that changed.
 */
export const archivePlan = (
  threads: ReadonlyArray<KindedThread>,
  days: ArchiveChatsAfterDays,
  nowMs: number,
): ArchivePlan => {
  const due: Array<ArchivePlan["due"][number]> = [];
  let nextDueAtMs: number | null = null;
  for (const thread of threads) {
    if (thread.archived || thread.deleted || thread.pinned || thread.busy) continue;
    if (effectiveThreadKind(thread.record).kind !== "chat") continue;
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

const KindedRow = Schema.Struct({
  ...RecordRow.fields,
  context_id: SignalboxContextId,
  updated_at: Schema.String,
  archived_at: Schema.NullOr(Schema.String),
  deleted_at: Schema.NullOr(Schema.String),
  pinned_at: Schema.NullOr(Schema.String),
  active_run_id: Schema.NullOr(Schema.String),
  activity_run_status: Schema.NullOr(Schema.String),
  pending_request: Schema.NullOr(Schema.String),
});
const decodeKinded = Schema.decodeUnknownSync(Schema.Array(KindedRow));

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

    /** Threads with a record, as the index has them, in the user's current contexts. */
    const kinded = (threadId?: ThreadId) =>
      Effect.gen(function* () {
        const rows = decodeKinded(
          yield* sql`SELECT k.thread_id, k.classified, k.override, k.work_started_at, i.context_id,
              json_extract(i.shell, '$.updatedAt') AS updated_at,
              json_extract(i.shell, '$.archivedAt') AS archived_at,
              json_extract(i.shell, '$.deletedAt') AS deleted_at,
              json_extract(i.shell, '$.pinnedAt') AS pinned_at,
              json_extract(i.shell, '$.activeRunId') AS active_run_id,
              json_extract(i.shell, '$.activityRunStatus') AS activity_run_status,
              json_extract(i.shell, '$.pendingRuntimeRequest') AS pending_request
            FROM thread_kinds k JOIN thread_index i ON i.thread_id = k.thread_id
            ${threadId === undefined ? sql`` : sql`WHERE k.thread_id = ${threadId}`}`,
        );
        const ids = yield* contexts.contextIds;
        return rows
          .filter((row) => contextAllows(ids, row.context_id))
          .map((row): KindedThread => ({
            record: toRecord(row),
            updatedAtMs: Date.parse(row.updated_at),
            archived: row.archived_at !== null,
            deleted: row.deleted_at !== null,
            pinned: row.pinned_at !== null,
            busy:
              row.active_run_id !== null ||
              row.activity_run_status !== null ||
              row.pending_request !== null,
          }));
      });

    /** Makes the alarm go off by the time of `threadId`'s chat (or every chat's). */
    const armFor = (threadId?: ThreadId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const plan = archivePlan(yield* kinded(threadId), yield* input.days, now);
        const at = plan.due.length > 0 ? now : plan.nextDueAtMs;
        if (at !== null) yield* alarm.armBy(at);
      });

    /** Archives one chat as its owner; a command id per idle stretch makes a retry a replay. */
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
            commandId: CommandId.make(`thread-kind-archive:${due.threadId}:${due.updatedAtMs}`),
            threadId: due.threadId,
          },
          { place: null, pools: null },
        )
        .pipe(
          Effect.as("archived" as const),
          Effect.catchTags({
            // It changed since the index saw it (a turn started): its next summary re-arms.
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

    /** Archives every chat idle past its time as of `nowMs`; one failing never stops the rest. */
    const sweep = (nowMs: number): Effect.Effect<SweepResult, SqlError> =>
      Effect.gen(function* () {
        const plan = archivePlan(yield* kinded(), yield* input.days, nowMs);
        const userId = yield* input.userId;
        if (userId === null || plan.due.length === 0) {
          return { archived: [], nextDueAtMs: plan.nextDueAtMs };
        }
        const actor = { userId, contextIds: yield* contexts.contextIds };
        const outcomes = yield* Effect.forEach(plan.due, (due) => archive(actor, due), {
          concurrency: 4,
        });
        const archived = plan.due
          .filter((_, index) => outcomes[index] === "archived")
          .map((due) => due.threadId);
        yield* Effect.annotateCurrentSpan({ "thread_kind.archived": archived.length });
        const retryAt = outcomes.includes("retry") ? nowMs + RETRY_MS : null;
        const next = [plan.nextDueAtMs, retryAt].filter((at) => at !== null);
        return { archived, nextDueAtMs: next.length === 0 ? null : Math.min(...next) };
      });

    /** The alarm going off: sweeps now and sets it for the next chat. */
    const alarmFired = Effect.gen(function* () {
      const result = yield* sweep(yield* Clock.currentTimeMillis);
      yield* alarm.reset(result.nextDueAtMs);
    });

    return { armFor, sweep, alarmFired };
  });
