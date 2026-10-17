import { ThreadId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import {
  liveOffer,
  type Note,
  NoteId,
  NoteReading,
  NoteText,
  NoteVisibility,
} from "@t3tools/contracts/signalboxNotes";
import * as Schema from "effect/Schema";

/** Notes as `UserNotes` stores them (`noteTables.ts`). */
export const NoteRow = Schema.Struct({
  id: NoteId,
  folder_id: Schema.NullOr(FolderId),
  author_id: Schema.String,
  visibility: NoteVisibility,
  text: NoteText,
  created_at: Schema.Number,
  reading: Schema.NullOr(Schema.fromJsonString(NoteReading)),
  accepted_thread_id: Schema.NullOr(ThreadId),
});
export type NoteRow = typeof NoteRow.Type;

export const decodeNoteRows = Schema.decodeUnknownSync(Schema.Array(NoteRow));
export const encodeReading = Schema.encodeSync(Schema.fromJsonString(NoteReading));

export const toNote = (row: NoteRow): Note => ({
  id: row.id,
  home: row.folder_id === null ? { _tag: "top" } : { _tag: "folder", folderId: row.folder_id },
  authorId: row.author_id,
  visibility: row.visibility,
  text: row.text,
  createdAt: row.created_at,
  ...(row.reading === null ? {} : { reading: row.reading }),
  ...(row.accepted_thread_id === null ? {} : { acceptedThreadId: row.accepted_thread_id }),
});

/** The row's offer while it still stands (`liveOffer`). */
export const offerOf = (row: NoteRow) => liveOffer(toNote(row));
