import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { Folder, FolderLevel } from "@t3tools/contracts/signalboxFolders";
import {
  liveOffer,
  type Note,
  type NoteCondition,
  type NoteOffer,
  type NoteReader,
  type NoteVisibility,
  type SignalboxNotesSnapshot,
} from "@t3tools/contracts/signalboxNotes";

/**
 * What web and mobile show of the notes: the pad of one level, the offer a
 * note carries, and the words around it. Pure, so both clients agree.
 */

const sameLevel = (a: FolderLevel, b: FolderLevel) =>
  a._tag === "top" ? b._tag === "top" : b._tag === "folder" && b.folderId === a.folderId;

/** A level's pad: the notes that live there and haven't become work, newest first as served. */
export function padNotes(snapshot: SignalboxNotesSnapshot, home: FolderLevel): ReadonlyArray<Note> {
  return snapshot.notes.filter(
    (note) => note.acceptedThreadId === undefined && sameLevel(note.home, home),
  );
}

/**
 * The notes a pad lists: where it can be shared, the ones of the visibility
 * the toggle picked; else every one, since nobody else can see them anyway.
 */
export function notesShown(
  pad: ReadonlyArray<Note>,
  shareable: boolean,
  visibility: NoteVisibility,
): ReadonlyArray<Note> {
  return shareable ? pad.filter((note) => note.visibility === visibility) : pad;
}

/** The offer waiting for the author's OK, or null when there's none to act on. */
export const noteOffer = liveOffer;

/** It can be read again when there's no offer to act on: never read, unclear, or turned down. */
export function canReadAgain(note: Note): boolean {
  if (note.acceptedThreadId !== undefined) return false;
  const reading = note.reading;
  return reading === undefined || reading._tag === "unclear" || reading.dismissed;
}

/** The visibility a note's menu switches it to. */
export function otherVisibility(note: Pick<Note, "visibility">): NoteVisibility {
  return note.visibility === "team" ? "private" : "team";
}

/** Only a folder in a work organization's tree has a team to share a note with. */
export function canShareWithTeam(folder: Folder | null): boolean {
  return folder !== null && folder.ownerId !== PERSONAL_CONTEXT_ID;
}

export interface ReaderNames {
  /** At the start of a sentence: "Your assistant", "The Signalbox agent". */
  readonly subject: string;
  /** Inside one: "your assistant's", "the Signalbox agent's". */
  readonly possessive: string;
}

/**
 * Who reads a note: the author's assistant for a private note, the folder's
 * agent for a team one. `folderName`: the note's folder, null at the top level.
 */
export function readerNames(reader: NoteReader, folderName: string | null): ReaderNames {
  if (reader === "assistant" || folderName === null) {
    return { subject: "Your assistant", possessive: "your assistant's" };
  }
  return { subject: `The ${folderName} agent`, possessive: `the ${folderName} agent's` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` as "Oct 20". */
const dayLabel = (on: string) =>
  `${MONTHS[Number(on.slice(5, 7)) - 1] ?? on} ${Number(on.slice(8, 10))}`;

/** A condition as its chip says it: "after #456 merges", "on Oct 20". */
export function conditionLabel(condition: NoteCondition): string {
  switch (condition._tag) {
    case "pullRequestMerged":
      return `after #${condition.number} merges`;
    case "date":
      return `on ${dayLabel(condition.on)}`;
  }
}

/** What accepting said, for the toast: whose work it is now, and when it acts. */
export function acceptedMessage(
  offer: NoteOffer,
  folderName: string | null,
): { readonly title: string; readonly description: string } {
  const names = readerNames(offer.reader, folderName);
  const condition = offer.condition;
  return {
    title: `Now ${names.possessive} work`,
    description:
      condition === undefined
        ? "It's off your pad and starting."
        : condition._tag === "pullRequestMerged"
          ? `It's off your pad. It prepares now and waits for #${condition.number} to merge.`
          : `It's off your pad. It prepares now and waits until ${dayLabel(condition.on)}.`,
  };
}
