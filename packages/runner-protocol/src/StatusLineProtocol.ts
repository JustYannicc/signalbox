import { ThreadStatusNoteInput } from "@t3tools/contracts/signalboxStatusLine";
import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/**
 * How a thread's agent reads and writes status lines (#670): the thread's
 * machine serves `thread_status`, `set_thread_status` and `folder_status` on
 * its context server and forwards each call here with the thread's drive
 * token (`DriveProtocol.ts`), which names the thread. The cloud answers for
 * that thread only: its own line from its object, and the roll-up of its home
 * folder from its owner's object.
 *
 * Every path answers 200 with its answer; a refused write is an answer for
 * the agent, not a failure to retry.
 */

export const STATUS_LINE_PATHS = {
  read: `${DRIVE_API_PREFIX}/status/read`,
  write: `${DRIVE_API_PREFIX}/status/write`,
  folder: `${DRIVE_API_PREFIX}/status/folder`,
} as const;

export const StatusState = Schema.Literals([
  "working",
  "waiting_on_person",
  "waiting_on_other",
  "idle",
  "archived",
]);

/** What the thread waits on (`@t3tools/client-runtime/state/threadStatusLine`). */
export const StatusWaitingOn = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("person"),
    reason: Schema.Literals(["failed", "input", "approval"]),
  }),
  Schema.Struct({ kind: Schema.Literal("work"), label: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("limit"), resetsAt: Schema.String }),
]);

/** A note as the agent reads it: plain strings, `writtenAt` in ISO. */
export const StatusNoteView = Schema.Struct({
  nextStep: Schema.String,
  whereItGotTo: Schema.String,
  writtenBy: Schema.Literals(["agent", "runtime"]),
  writtenAt: Schema.String,
});
export type StatusNoteView = typeof StatusNoteView.Type;

export const ThreadStatusAnswer = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  state: StatusState,
  /** The state in a few words, as people see it lead the line. */
  headline: Schema.String,
  waitingOn: Schema.NullOr(StatusWaitingOn),
  note: Schema.NullOr(StatusNoteView),
});
export type ThreadStatusAnswer = typeof ThreadStatusAnswer.Type;

export const SetThreadStatusAnswer = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("written"), note: StatusNoteView }),
  Schema.Struct({ _tag: Schema.Literal("failed"), message: Schema.String }),
]);
export type SetThreadStatusAnswer = typeof SetThreadStatusAnswer.Type;

export const FolderStatusThread = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  state: StatusState,
  headline: Schema.String,
  note: Schema.NullOr(StatusNoteView),
});

export const FolderStatusAnswer = Schema.Struct({
  /** The thread's home folder; null for its owner's top level. */
  folder: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  counts: Schema.Struct({ working: Schema.Number, waiting: Schema.Number, idle: Schema.Number }),
  /** "2 working · 1 waiting"; null when nothing moves. */
  summary: Schema.NullOr(Schema.String),
  /** The threads that matter most, at most two. */
  highlights: Schema.Array(
    Schema.Struct({ threadId: Schema.String, reason: Schema.String, since: Schema.String }),
  ),
  /** Live threads at home in the folder or below, people's attention first. */
  threads: Schema.Array(FolderStatusThread),
  /** Live threads there beyond `threads`. */
  more: Schema.Number,
});
export type FolderStatusAnswer = typeof FolderStatusAnswer.Type;

export const statusLineJson = {
  writeRequest: jsonCodec(ThreadStatusNoteInput),
  read: jsonCodec(ThreadStatusAnswer),
  write: jsonCodec(SetThreadStatusAnswer),
  folder: jsonCodec(FolderStatusAnswer),
};
