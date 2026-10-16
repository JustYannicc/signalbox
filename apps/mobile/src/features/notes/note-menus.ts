// signalbox: what a note's long-press / ⋯ menu offers, and what each choice means.
import type { MenuAction } from "@react-native-menu/menu";
import { canReadAgain, otherVisibility } from "@t3tools/client-runtime/state/signalboxNotes";
import type { Note } from "@t3tools/contracts/signalboxNotes";

export function noteMenuActions(note: Note, input: { readonly canShare: boolean }): MenuAction[] {
  return [
    ...(canReadAgain(note) ? [{ id: "note:read-again", title: "Read again" }] : []),
    ...(input.canShare
      ? [
          otherVisibility(note) === "private"
            ? { id: "note:private", title: "Make private", image: "lock" }
            : { id: "note:team", title: "Share with team", image: "person.2" },
        ]
      : []),
    { id: "note:delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}

export type NoteMenuChoice =
  | { readonly _tag: "readAgain" }
  | { readonly _tag: "visibility"; readonly visibility: Note["visibility"] }
  | { readonly _tag: "delete" };

/** The change a note menu choice asks for; null when there's nothing to change. */
export function parseNoteMenuEvent(note: Note, event: string): NoteMenuChoice | null {
  if (event === "note:read-again") return canReadAgain(note) ? { _tag: "readAgain" } : null;
  if (event === "note:delete") return { _tag: "delete" };
  const visibility = event === "note:team" ? "team" : event === "note:private" ? "private" : null;
  if (visibility === null || visibility === note.visibility) return null;
  return { _tag: "visibility", visibility };
}
