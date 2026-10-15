/**
 * Signalbox thread kinds. Part of `WsRpcGroup`.
 *
 * Every thread is a chat or a task. A chat is thinking out loud: questions,
 * research, options. A task is committed work and leaves through Done. Both
 * are the same thread underneath; the kind changes how it shows and what its
 * agent is told, never what the agent can do (#46).
 *
 * A classifier sets the kind from the first message. A chat whose turn
 * changes files has started real work and becomes a task on its own. The
 * user's flip wins over both, and flipping back to what the thread would be
 * anyway drops the flip. Chats idle for `archiveChatsAfterDays` archive
 * themselves; tasks never do.
 *
 * Only Signalbox Cloud serves these (`capabilities.threadKinds`). A
 * self-hosted server answers `SignalboxThreadKindsUnavailableError`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ThreadId } from "./baseSchemas.ts";

export const SIGNALBOX_THREAD_KINDS_WS_METHODS = {
  subscribe: "signalbox.threadKinds.subscribe",
  setKind: "signalbox.threadKinds.setKind",
  setArchiveChatsAfterDays: "signalbox.threadKinds.setArchiveChatsAfterDays",
} as const;

export const SIGNALBOX_THREAD_KINDS_REQUIRED_SCOPES = {
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind]: AuthOrchestrationOperateScope,
  [SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays]: AuthSettingsWriteScope,
} as const;

export const ThreadKind = Schema.Literals(["chat", "task"]);
export type ThreadKind = typeof ThreadKind.Type;

/** Chats idle this long archive themselves unless the user picks another number. */
export const DEFAULT_ARCHIVE_CHATS_AFTER_DAYS = 7;
export const MAX_ARCHIVE_CHATS_AFTER_DAYS = 90;

/** Days a chat stays idle before it archives itself. Null: chats never archive themselves. */
export const ArchiveChatsAfterDays = Schema.NullOr(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MAX_ARCHIVE_CHATS_AFTER_DAYS),
  ),
);
export type ArchiveChatsAfterDays = typeof ArchiveChatsAfterDays.Type;

/** What the environment knows about one thread's kind. Threads without one show as tasks. */
export const ThreadKindRecord = Schema.Struct({
  threadId: ThreadId,
  /** The classifier's answer from the first message. Null: not classified (yet). */
  classified: Schema.NullOr(ThreadKind),
  /** The user's flip. Null: none, the thread is what it would be anyway. */
  override: Schema.NullOr(ThreadKind),
  /** When a turn first changed files: a chat that did has started real work. */
  workStartedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type ThreadKindRecord = typeof ThreadKindRecord.Type;

export const SignalboxThreadKindsSnapshot = Schema.Struct({
  threads: Schema.Array(ThreadKindRecord),
  archiveChatsAfterDays: ArchiveChatsAfterDays,
});
export type SignalboxThreadKindsSnapshot = typeof SignalboxThreadKindsSnapshot.Type;

export const ThreadKindSetInput = Schema.Struct({
  threadId: ThreadId,
  kind: ThreadKind,
});
export type ThreadKindSetInput = typeof ThreadKindSetInput.Type;

export const ArchiveChatsAfterDaysSetInput = Schema.Struct({
  days: ArchiveChatsAfterDays,
});
export type ArchiveChatsAfterDaysSetInput = typeof ArchiveChatsAfterDaysSetInput.Type;

/** What a thread is without the user's flip: a chat that started real work is a task. */
export function naturalThreadKind(
  record: Pick<ThreadKindRecord, "classified" | "workStartedAt"> | undefined,
): ThreadKind {
  if (record === undefined || record.classified === null) return "task";
  return record.classified === "chat" && record.workStartedAt !== null ? "task" : record.classified;
}

/**
 * The kind a thread shows and its agent is told. `switchedByWork`: it was
 * classified a chat and became a task because a turn changed files.
 */
export function effectiveThreadKind(record: ThreadKindRecord | undefined): {
  readonly kind: ThreadKind;
  readonly switchedByWork: boolean;
} {
  const natural = naturalThreadKind(record);
  const kind = record?.override ?? natural;
  return {
    kind,
    switchedByWork:
      record?.override === null && record.classified === "chat" && record.workStartedAt !== null,
  };
}

/** The override that makes a thread `kind`: none when that's what it is anyway. */
export function overrideFor(
  record: Pick<ThreadKindRecord, "classified" | "workStartedAt"> | undefined,
  kind: ThreadKind,
): ThreadKind | null {
  return naturalThreadKind(record) === kind ? null : kind;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an idle chat archives itself: `days` after the thread last changed.
 * Anything that changes it (a message, a turn, opening it, bringing it back
 * from the archive) starts the wait again. Null: never.
 */
export function chatArchiveDueAtMs(
  lastChangedAtMs: number,
  days: ArchiveChatsAfterDays,
): number | null {
  return days === null ? null : lastChangedAtMs + days * DAY_MS;
}

export class SignalboxThreadKindsUnavailableError extends Schema.TaggedError<SignalboxThreadKindsUnavailableError>()(
  "SignalboxThreadKindsUnavailableError",
  {},
) {
  override get message() {
    return "This environment doesn't keep chat and task kinds.";
  }
}

export class SignalboxThreadKindsError extends Schema.TaggedError<SignalboxThreadKindsError>()(
  "SignalboxThreadKindsError",
  { message: Schema.String },
) {}

const ThreadKindsErrors = Schema.Union([
  SignalboxThreadKindsUnavailableError,
  SignalboxThreadKindsError,
  EnvironmentAuthorizationError,
]);

/** Every kind now and after every change. */
const SubscribeRpc = Rpc.make(SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignalboxThreadKindsSnapshot,
  error: ThreadKindsErrors,
  stream: true,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_THREAD_KINDS_RPCS = [
  SubscribeRpc,
  Rpc.make(SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind, {
    payload: ThreadKindSetInput,
    success: SignalboxThreadKindsSnapshot,
    error: ThreadKindsErrors,
  }),
  Rpc.make(SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays, {
    payload: ArchiveChatsAfterDaysSetInput,
    success: SignalboxThreadKindsSnapshot,
    error: ThreadKindsErrors,
  }),
] as const;
