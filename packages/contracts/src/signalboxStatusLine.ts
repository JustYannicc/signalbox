/**
 * Signalbox thread status lines. Part of `WsRpcGroup`.
 *
 * Every thread says at a glance what's going on and what has to happen next,
 * readable by someone who has never seen it (#670). Code sets the state and
 * what the thread waits on, live, from the thread's own shell
 * (`@t3tools/client-runtime/state/threadStatusLine`). The agent writes the
 * other two lines, the note: the next step, and where it got to, which is
 * also the resume note (#182). It writes them during every turn; when a turn
 * ends without, the runtime writes them from the turn instead.
 *
 * One shared line per thread: everyone with access sees the same note.
 *
 * Only Signalbox Cloud keeps notes (`capabilities.threadStatusNotes`). A
 * self-hosted server answers `SignalboxThreadStatusUnavailableError`, and
 * its threads show the code half of the line only.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SIGNALBOX_THREAD_STATUS_WS_METHODS = {
  subscribe: "signalbox.threadStatus.subscribe",
} as const;

export const SIGNALBOX_THREAD_STATUS_REQUIRED_SCOPES = {
  [SIGNALBOX_THREAD_STATUS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;

/** Longest next step: one line in a row. */
export const STATUS_NEXT_STEP_MAX_LENGTH = 160;
/** Longest "where it got to": one or two sentences. */
export const STATUS_WHERE_IT_GOT_TO_MAX_LENGTH = 400;

const lineOf = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

/** What an agent (or the runtime for it) writes. */
export const ThreadStatusNoteInput = Schema.Struct({
  /** What has to happen next, and who does it, in one line. */
  nextStep: lineOf(STATUS_NEXT_STEP_MAX_LENGTH),
  /** Where the work got to, in one or two plain sentences. */
  whereItGotTo: lineOf(STATUS_WHERE_IT_GOT_TO_MAX_LENGTH),
});
export type ThreadStatusNoteInput = typeof ThreadStatusNoteInput.Type;

export const ThreadStatusNoteAuthor = Schema.Literals(["agent", "runtime"]);
export type ThreadStatusNoteAuthor = typeof ThreadStatusNoteAuthor.Type;

export const ThreadStatusNote = Schema.Struct({
  ...ThreadStatusNoteInput.fields,
  writtenAt: Schema.DateTimeUtc,
  /** The agent during a turn, or the runtime for a turn that ended without one. */
  writtenBy: ThreadStatusNoteAuthor,
  /** The turn it was written during or for. Null: written outside any turn. */
  runId: Schema.NullOr(RunId),
});
export type ThreadStatusNote = typeof ThreadStatusNote.Type;

export const ThreadStatusNoteEntry = Schema.Struct({
  threadId: ThreadId,
  note: ThreadStatusNote,
});
export type ThreadStatusNoteEntry = typeof ThreadStatusNoteEntry.Type;

/**
 * The stream: every note of the user's threads that aren't archived first,
 * then one item per changed note, so a turn's new note costs one small frame.
 * An archived thread's note arrives when it changes; a client that needs it
 * otherwise reads it with the thread.
 */
export const SignalboxThreadStatusStreamItem = Schema.Union([
  Schema.TaggedStruct("snapshot", { notes: Schema.Array(ThreadStatusNoteEntry) }),
  Schema.TaggedStruct("note", { threadId: ThreadId, note: ThreadStatusNote }),
]);
export type SignalboxThreadStatusStreamItem = typeof SignalboxThreadStatusStreamItem.Type;

export class SignalboxThreadStatusUnavailableError extends Schema.TaggedError<SignalboxThreadStatusUnavailableError>()(
  "SignalboxThreadStatusUnavailableError",
  {},
) {
  override get message() {
    return "This environment doesn't keep thread status notes.";
  }
}

const ThreadStatusErrors = Schema.Union([
  SignalboxThreadStatusUnavailableError,
  EnvironmentAuthorizationError,
]);

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_THREAD_STATUS_RPCS = [
  Rpc.make(SIGNALBOX_THREAD_STATUS_WS_METHODS.subscribe, {
    payload: Schema.Struct({}),
    success: SignalboxThreadStatusStreamItem,
    error: ThreadStatusErrors,
    stream: true,
  }),
] as const;
