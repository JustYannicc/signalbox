import { ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { type Folder, FolderId } from "@t3tools/contracts/signalboxFolders";
import { type Note, NoteId, type SignalboxNotesSnapshot } from "@t3tools/contracts/signalboxNotes";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptedMessage,
  canReadAgain,
  canShareWithTeam,
  conditionLabel,
  noteOffer,
  notesShown,
  otherVisibility,
  padNotes,
  readerNames,
} from "./notesModel.ts";

const WORK = FolderId.make("work");

const note = (id: string, overrides: Partial<Note> = {}): Note => ({
  id: NoteId.make(id),
  home: { _tag: "folder", folderId: WORK },
  authorId: "user-1",
  visibility: "private",
  text: `note ${id}`,
  createdAt: 1,
  ...overrides,
});

const offer = {
  _tag: "offer",
  reader: "folder",
  meaning: "Port Kevin's retry approach",
  action: "Start a task to port it",
  dismissed: false,
} as const;

const snapshot = (notes: ReadonlyArray<Note>): SignalboxNotesSnapshot => ({ revision: 1, notes });

describe("padNotes", () => {
  it("shows a level's notes that haven't become work, in the server's newest-first order", () => {
    const pad = padNotes(
      snapshot([
        note("top", { home: { _tag: "top" }, createdAt: 5 }),
        note("accepted", { createdAt: 4, acceptedThreadId: ThreadId.make("t-1") }),
        note("new", { createdAt: 3 }),
        note("old", { createdAt: 1 }),
      ]),
      { _tag: "folder", folderId: WORK },
    );
    expect(pad.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

  it("keeps the top level's pad to notes with no folder", () => {
    const pad = padNotes(snapshot([note("a"), note("top", { home: { _tag: "top" } })]), {
      _tag: "top",
    });
    expect(pad.map((entry) => entry.id)).toEqual(["top"]);
  });
});

describe("noteOffer", () => {
  it("is the offer until it's dismissed or accepted", () => {
    expect(noteOffer(note("a", { reading: offer }))).toEqual(offer);
    expect(noteOffer(note("a", { reading: { ...offer, dismissed: true } }))).toBeNull();
    expect(
      noteOffer(note("a", { reading: offer, acceptedThreadId: ThreadId.make("t-1") })),
    ).toBeNull();
    expect(noteOffer(note("a", { reading: { _tag: "unclear", reader: "assistant" } }))).toBeNull();
    expect(noteOffer(note("a"))).toBeNull();
  });
});

describe("notesShown", () => {
  const pad = [note("a"), note("b", { visibility: "team" })];

  it("lists the toggle's visibility where the pad can be shared", () => {
    expect(notesShown(pad, true, "team").map((entry) => entry.id)).toEqual(["b"]);
    expect(notesShown(pad, true, "private").map((entry) => entry.id)).toEqual(["a"]);
  });

  it("lists every note where there's nobody to share with", () => {
    expect(notesShown(pad, false, "team").map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("a note's quiet actions", () => {
  it("reads again only when there's no offer to act on", () => {
    expect(canReadAgain(note("a"))).toBe(true);
    expect(canReadAgain(note("a", { reading: { _tag: "unclear", reader: "assistant" } }))).toBe(
      true,
    );
    expect(canReadAgain(note("a", { reading: { ...offer, dismissed: true } }))).toBe(true);
    expect(canReadAgain(note("a", { reading: offer }))).toBe(false);
    expect(canReadAgain(note("a", { acceptedThreadId: ThreadId.make("t-1") }))).toBe(false);
  });

  it("switches to the other visibility", () => {
    expect(otherVisibility(note("a"))).toBe("team");
    expect(otherVisibility(note("a", { visibility: "team" }))).toBe("private");
  });
});

describe("words", () => {
  it("names the assistant for private notes and the folder's agent for team ones", () => {
    expect(readerNames("assistant", "Signalbox").subject).toBe("Your assistant");
    expect(readerNames("folder", "Signalbox")).toEqual({
      subject: "The Signalbox agent",
      possessive: "the Signalbox agent's",
    });
    expect(readerNames("folder", null).subject).toBe("Your assistant");
  });

  it("says conditions as chips do", () => {
    expect(conditionLabel({ _tag: "pullRequestMerged", number: 456 })).toBe("after #456 merges");
    expect(conditionLabel({ _tag: "date", on: "2026-10-20" })).toBe("on Oct 20");
  });

  it("never claims work waits when it starts now", () => {
    expect(acceptedMessage(offer, "Signalbox")).toEqual({
      title: "Now the Signalbox agent's work",
      description: "It's off your pad and starting.",
    });
    expect(
      acceptedMessage(
        { ...offer, condition: { _tag: "pullRequestMerged", number: 456 } },
        "Signalbox",
      ).description,
    ).toBe("It's off your pad. It prepares now and waits for #456 to merge.");
    expect(
      acceptedMessage({ ...offer, condition: { _tag: "date", on: "2026-10-20" } }, "Signalbox")
        .description,
    ).toBe("It's off your pad. It prepares now and waits until Oct 20.");
  });
});

describe("canShareWithTeam", () => {
  const folder = (ownerId: string): Folder => ({
    id: WORK,
    name: "Work",
    parentId: null,
    position: 0,
    ownerId: SignalboxContextId.make(ownerId),
    files: { projectId: ProjectId.make("p") },
  });

  it("offers Team only in an organization's folders", () => {
    expect(canShareWithTeam(folder("org-1"))).toBe(true);
    expect(canShareWithTeam(folder(PERSONAL_CONTEXT_ID))).toBe(false);
    expect(canShareWithTeam(null)).toBe(false);
  });
});
