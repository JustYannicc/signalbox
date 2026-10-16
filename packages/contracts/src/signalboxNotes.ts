/**
 * Signalbox notes. Part of `WsRpcGroup`.
 *
 * A note is a half-formed thought with a home (a folder, or the top level)
 * and an author, private by default. It has no status: it never enters the
 * pipeline and is never a needs-you, so writing one carries no obligation. A
 * folder's pad is the view of the notes that live there; the top level's is
 * the pad for notes with no folder (#318, decided on #636).
 *
 * After a note is written, whoever reads it for that level offers what it
 * thinks the note meant, once: the author's assistant for a private note, the
 * folder's agent for a team note. Ignoring the offer changes nothing.
 * Accepting it starts a task in the note's home with the note's own words as
 * its origin; the note leaves the pad and stays linked to that task.
 *
 * Only Signalbox Cloud serves these (`capabilities.notes`). A self-hosted
 * server answers `SignalboxNotesUnavailableError`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { FolderLevel } from "./signalboxFolders.ts";

export const SIGNALBOX_NOTES_WS_METHODS = {
  subscribe: "signalbox.notes.subscribe",
  create: "signalbox.notes.create",
  update: "signalbox.notes.update",
  delete: "signalbox.notes.delete",
  readAgain: "signalbox.notes.readAgain",
  dismissReading: "signalbox.notes.dismissReading",
  accept: "signalbox.notes.accept",
} as const;

/** Reading notes is reading your own pads; the rest changes them or starts work. */
export const SIGNALBOX_NOTES_REQUIRED_SCOPES = {
  [SIGNALBOX_NOTES_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_NOTES_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [SIGNALBOX_NOTES_WS_METHODS.update]: AuthOrchestrationOperateScope,
  [SIGNALBOX_NOTES_WS_METHODS.delete]: AuthOrchestrationOperateScope,
  [SIGNALBOX_NOTES_WS_METHODS.readAgain]: AuthOrchestrationOperateScope,
  [SIGNALBOX_NOTES_WS_METHODS.dismissReading]: AuthOrchestrationOperateScope,
  [SIGNALBOX_NOTES_WS_METHODS.accept]: AuthOrchestrationOperateScope,
} as const;

export const NoteId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("SignalboxNoteId"),
);
export type NoteId = typeof NoteId.Type;

export const NOTE_TEXT_MAX_LENGTH = 4000;
/** The author's words, kept exactly as written. */
export const NoteText = TrimmedNonEmptyString.check(Schema.isMaxLength(NOTE_TEXT_MAX_LENGTH));

/**
 * Who may read a note. `private`: only its author and their assistant.
 * `team`: the folder's agent too. Notes at the top level are always private.
 */
export const NoteVisibility = Schema.Literals(["private", "team"]);
export type NoteVisibility = typeof NoteVisibility.Type;

/** Who wrote the offer: the author's assistant (private notes) or the folder's agent (team notes). */
export const NoteReader = Schema.Literals(["assistant", "folder"]);
export type NoteReader = typeof NoteReader.Type;

/**
 * When the work a note asks for should start, as a structured condition
 * rather than prose, so it can't go stale the way a written "after" does.
 */
export const NoteCondition = Schema.Union([
  Schema.TaggedStruct("pullRequestMerged", { number: PositiveInt }),
  /** A calendar day, `YYYY-MM-DD`. */
  Schema.TaggedStruct("date", { on: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)) }),
]);
export type NoteCondition = typeof NoteCondition.Type;

const ReadingLine = TrimmedNonEmptyString.check(Schema.isMaxLength(400));

/**
 * What the reader made of a note. `offer`: "did you mean …? I can …", with
 * one click to act; `dismissed` once the author said it isn't that. `unclear`:
 * it couldn't tell, so the note stays a plain note.
 */
export const NoteReading = Schema.Union([
  Schema.TaggedStruct("offer", {
    reader: NoteReader,
    /** What it thinks the note means, in its own words. */
    meaning: ReadingLine,
    /** What it would do on OK, starting with a verb ("Start a task to …"). */
    action: ReadingLine,
    condition: Schema.optionalKey(NoteCondition),
    dismissed: Schema.Boolean,
  }),
  Schema.TaggedStruct("unclear", { reader: NoteReader }),
]);
export type NoteReading = typeof NoteReading.Type;
export type NoteOffer = Extract<NoteReading, { readonly _tag: "offer" }>;

/** Who reads a note: the author's assistant for a private one, the folder's agent for a team one. */
export const readerOf = (visibility: NoteVisibility): NoteReader =>
  visibility === "team" ? "folder" : "assistant";

export const Note = Schema.Struct({
  id: NoteId,
  /** Its home: the folder whose pad it's on, or the top level. */
  home: FolderLevel,
  /** The person who wrote it. */
  authorId: TrimmedNonEmptyString,
  visibility: NoteVisibility,
  text: NoteText,
  createdAt: NonNegativeInt,
  /** Absent until it's been read, and when reading failed. */
  reading: Schema.optionalKey(NoteReading),
  /** The task it became. Such a note is off the pad and stays linked. */
  acceptedThreadId: Schema.optionalKey(ThreadId),
});
export type Note = typeof Note.Type;

/** The note's offer while it still stands: not dismissed, and the note not yet a task. */
export const liveOffer = (note: Pick<Note, "reading" | "acceptedThreadId">): NoteOffer | null =>
  note.reading?._tag === "offer" && !note.reading.dismissed && note.acceptedThreadId === undefined
    ? note.reading
    : null;

export const SignalboxNotesSnapshot = Schema.Struct({
  /** Increases on every committed change. */
  revision: NonNegativeInt,
  /** Newest first, accepted ones included. */
  notes: Schema.Array(Note),
});
export type SignalboxNotesSnapshot = typeof SignalboxNotesSnapshot.Type;

export const NoteCreateInput = Schema.Struct({
  home: FolderLevel,
  text: NoteText,
  /** Private when absent. A top-level note is always private. */
  visibility: Schema.optionalKey(NoteVisibility),
});
export type NoteCreateInput = typeof NoteCreateInput.Type;

/** Changes the given fields. New words are read again. */
export const NoteUpdateInput = Schema.Struct({
  id: NoteId,
  text: Schema.optionalKey(NoteText),
  visibility: Schema.optionalKey(NoteVisibility),
});
export type NoteUpdateInput = typeof NoteUpdateInput.Type;

export const NoteIdInput = Schema.Struct({ id: NoteId });
export type NoteIdInput = typeof NoteIdInput.Type;

/**
 * Turns an offer into work: a task in the note's home that starts with the
 * note's words. `modelSelection`: what it runs on, as a new thread there would.
 */
export const NoteAcceptInput = Schema.Struct({
  id: NoteId,
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type NoteAcceptInput = typeof NoteAcceptInput.Type;

export const NoteAcceptResult = Schema.Struct({ threadId: ThreadId });
export type NoteAcceptResult = typeof NoteAcceptResult.Type;

export class SignalboxNotesUnavailableError extends Schema.TaggedError<SignalboxNotesUnavailableError>()(
  "SignalboxNotesUnavailableError",
  {},
) {
  override get message(): string {
    return "Notes are only available in Signalbox Cloud.";
  }
}

/** The change was refused or failed; `message` says why, for the user. */
export class SignalboxNoteError extends Schema.TaggedError<SignalboxNoteError>()(
  "SignalboxNoteError",
  { message: Schema.String },
) {}

const NoteErrors = Schema.Union([
  SignalboxNotesUnavailableError,
  SignalboxNoteError,
  EnvironmentAuthorizationError,
]);

const change = <const Tag extends string, P extends Schema.Top>(tag: Tag, payload: P) =>
  Rpc.make(tag, { payload, success: SignalboxNotesSnapshot, error: NoteErrors });

/** Every note now and after every change, its readings included. */
const SubscribeRpc = Rpc.make(SIGNALBOX_NOTES_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignalboxNotesSnapshot,
  error: NoteErrors,
  stream: true,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_NOTES_RPCS = [
  SubscribeRpc,
  change(SIGNALBOX_NOTES_WS_METHODS.create, NoteCreateInput),
  change(SIGNALBOX_NOTES_WS_METHODS.update, NoteUpdateInput),
  change(SIGNALBOX_NOTES_WS_METHODS.delete, NoteIdInput),
  change(SIGNALBOX_NOTES_WS_METHODS.readAgain, NoteIdInput),
  change(SIGNALBOX_NOTES_WS_METHODS.dismissReading, NoteIdInput),
  Rpc.make(SIGNALBOX_NOTES_WS_METHODS.accept, {
    payload: NoteAcceptInput,
    success: NoteAcceptResult,
    error: NoteErrors,
  }),
] as const;
