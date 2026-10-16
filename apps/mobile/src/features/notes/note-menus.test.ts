import { NoteId, type Note, type NoteReading } from "@t3tools/contracts/signalboxNotes";
import { describe, expect, it } from "@effect/vitest";

import { noteMenuActions, parseNoteMenuEvent } from "./note-menus";

const offer = (dismissed: boolean): NoteReading => ({
  _tag: "offer",
  reader: "assistant",
  meaning: "You want the invoices filed.",
  action: "Start a task to file them.",
  dismissed,
});

const note = (reading?: NoteReading, visibility: Note["visibility"] = "private"): Note => ({
  id: NoteId.make("note"),
  home: { _tag: "top" },
  authorId: "me",
  visibility,
  text: "file invoices",
  createdAt: 1,
  ...(reading ? { reading } : {}),
});

const ids = (target: Note, canShare = false) =>
  noteMenuActions(target, { canShare }).map((action) => action.id);

describe("a note's menu", () => {
  it("offers reading again only when there's no offer to act on", () => {
    expect(ids(note())).toEqual(["note:read-again", "note:delete"]);
    expect(ids(note({ _tag: "unclear", reader: "assistant" }))).toContain("note:read-again");
    expect(ids(note(offer(true)))).toContain("note:read-again");
    expect(ids(note(offer(false)))).toEqual(["note:delete"]);
    expect(parseNoteMenuEvent(note(offer(false)), "note:read-again")).toBeNull();
  });

  it("shares or makes private only where the folder has a team", () => {
    expect(ids(note(offer(false)), true)).toEqual(["note:team", "note:delete"]);
    expect(ids(note(offer(false), "team"), true)).toEqual(["note:private", "note:delete"]);
    expect(parseNoteMenuEvent(note(), "note:team")).toEqual({
      _tag: "visibility",
      visibility: "team",
    });
    expect(parseNoteMenuEvent(note(undefined, "team"), "note:team")).toBeNull();
  });
});
