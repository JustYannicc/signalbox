/**
 * Native Spaces notes: Notion-style pages that live in a space instead of a
 * third-party doc. PLACEHOLDER: an in-memory store seeded with fixtures, so
 * new pages and edits survive navigation but not a reload.
 */
import { useMemo } from "react";
import { create } from "zustand";

import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { SPACES_SOURCES, type SpacesItemFixture } from "./spacesFixtures";
import { spaceItems } from "./spacesModel";
import type { Space } from "./spacesSpace";

export const NOTE_BLOCK_TYPES = [
  "paragraph",
  "heading1",
  "heading2",
  "todo",
  "bullet",
  "callout",
  "link",
] as const;
export type NoteBlockType = (typeof NOTE_BLOCK_TYPES)[number];

export interface NoteBlock {
  readonly id: string;
  readonly type: NoteBlockType;
  readonly text: string;
  readonly checked?: boolean;
  /** For `link` blocks: the library item the chip points at. */
  readonly itemId?: string;
}

export interface NoteBacklink {
  readonly kind: "chat" | "task" | "project";
  readonly label: string;
  /** Fixture target: a shared chat/task, or a project's agent. */
  readonly target:
    | { readonly route: "shared"; readonly threadId: string }
    | { readonly route: "agent"; readonly agentId: string };
}

export interface SpacesNote {
  readonly id: string;
  /** Home section id. */
  readonly space: string;
  readonly title: string;
  /** Section inside the space, " / "-separated like item locations. */
  readonly location: string;
  readonly updatedAt: string;
  readonly blocks: readonly NoteBlock[];
  readonly backlinks: readonly NoteBacklink[];
}

let nextId = 0;
export const newBlockId = () => `block-${++nextId}`;
export const block = (type: NoteBlockType, text = "", extra?: Partial<NoteBlock>): NoteBlock => ({
  id: newBlockId(),
  type,
  text,
  ...extra,
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SEED_NOTES: readonly SpacesNote[] = [
  {
    id: "note-worker-deploy",
    space: "work-northwind",
    title: "Background worker deploy",
    location: "t3code / Notes",
    updatedAt: ago(18),
    blocks: [
      block(
        "paragraph",
        "Run a background worker next to the Signalbox server on the existing deploy host, so agents in this space get a long-running worker without another server.",
      ),
      block(
        "callout",
        "The deploy tool owns the reverse proxy. Add a domain there instead of opening ports by hand.",
      ),
      block("heading1", "Steps"),
      block("todo", "Create the deploy project and link the repo", { checked: true }),
      block("todo", "Add secrets through Executor, not the compose file", { checked: true }),
      block("todo", "Pin the image tag before the first deploy"),
      block("todo", "Health check against /api/health"),
      block("heading1", "Context"),
      block("link", "", { itemId: "northwind-drive-q3-plan" }),
      block("link", "", { itemId: "confluence-onboarding" }),
      block(
        "paragraph",
        "Open question: does the worker need its own Slack token, or can it borrow the space's?",
      ),
    ],
    backlinks: [
      { kind: "project", label: "t3code", target: { route: "agent", agentId: "project-t3code" } },
    ],
  },
  {
    id: "note-firmware-rollout",
    space: "work-northwind",
    title: "Firmware 3.3 rollout notes",
    location: "Terminal / Notes",
    updatedAt: ago(3 * 60),
    blocks: [
      block("heading1", "Before 07:00"),
      block("bullet", "Pull the pilot list from the sheet and confirm windows"),
      block("bullet", "Watch the resume path, it is what broke in 3.2"),
      block("link", "", { itemId: "jira-card-timeout" }),
      block("link", "", { itemId: "slack-rollout" }),
      block("heading2", "Rollback"),
      block("paragraph", "Pull the profile back before 09:00 if contactless reads drop."),
    ],
    backlinks: [
      {
        kind: "chat",
        label: "Which terminals get the rollout first?",
        target: { route: "shared", threadId: "chat-terminal-rollout" },
      },
      {
        kind: "task",
        label: "Ship A920 receipt printer fix",
        target: { route: "shared", threadId: "ta-printer-fix" },
      },
      {
        kind: "project",
        label: "terminal-app",
        target: { route: "agent", agentId: "project-terminal-app" },
      },
    ],
  },
  {
    id: "note-mountain-weekend",
    space: "personal",
    title: "Mountain weekend",
    location: "Journal",
    updatedAt: ago(2 * 24 * 60),
    blocks: [
      block("paragraph", "The summit at sunrise was worth the early train. Do it again in winter."),
      block("link", "", { itemId: "photos-2026-09" }),
      block("todo", "Send Leona the photo from the ridge"),
    ],
    backlinks: [],
  },
];

interface SpacesNotesState {
  readonly notes: Readonly<Record<string, SpacesNote>>;
  /** Creates an empty page in the space's Notes and returns its id. */
  readonly createNote: (space: string, location?: string) => string;
  readonly updateNote: (id: string, update: (note: SpacesNote) => SpacesNote) => void;
  /** Removes the page; returns it so an Undo can put it back. */
  readonly deleteNote: (id: string) => SpacesNote | undefined;
  readonly restoreNote: (note: SpacesNote) => void;
}

let createdCount = 0;

export const useSpacesNotes = create<SpacesNotesState>()((set, get) => ({
  notes: Object.fromEntries(SEED_NOTES.map((note) => [note.id, note])),
  createNote: (space, location = "Notes") => {
    const id = `note-new-${++createdCount}`;
    const note: SpacesNote = {
      id,
      space,
      title: "",
      location,
      updatedAt: new Date().toISOString(),
      blocks: [block("paragraph")],
      backlinks: [],
    };
    set((state) => ({ notes: { ...state.notes, [id]: note } }));
    return id;
  },
  updateNote: (id, update) =>
    set((state) => {
      const note = state.notes[id];
      if (!note) return state;
      const next = { ...update(note), updatedAt: new Date().toISOString() };
      return { notes: { ...state.notes, [id]: next } };
    }),
  deleteNote: (id) => {
    const note = get().notes[id];
    if (note) {
      set((state) => {
        const { [id]: _removed, ...notes } = state.notes;
        return { notes };
      });
    }
    return note;
  },
  restoreNote: (note) => set((state) => ({ notes: { ...state.notes, [note.id]: note } })),
}));

/** Key in the personal Home archive (restorable from Home › Archived). */
export const noteArchiveKey = (noteId: string) => `spaces-note:${noteId}`;

export const noteTitle = (note: SpacesNote) => note.title.trim() || "Untitled";

export function notesSourceId(space: string): string {
  return (
    SPACES_SOURCES.find((source) => source.space === space && source.connector === "notes")?.id ??
    "notes"
  );
}

/** A note as a library row, so it lists, filters and searches like any item. */
export function noteToItem(note: SpacesNote): SpacesItemFixture {
  const firstText = note.blocks.find((entry) => entry.type !== "link" && entry.text.trim());
  return {
    id: note.id,
    name: noteTitle(note),
    type: "note",
    source: notesSourceId(note.space),
    space: note.space,
    location: note.location,
    owner: "You",
    updatedAt: note.updatedAt,
    usedInChats: note.backlinks.filter((link) => link.kind !== "project").length,
    pinned: false,
    excerpt: firstText?.text ?? "Empty page",
  };
}

/** Synced items plus the space's native notes (minus archived), newest first. */
export function useSpaceItems(space: Space): readonly SpacesItemFixture[] {
  const notes = useSpacesNotes((state) => state.notes);
  const archived = useHomeSectionStore((state) => state.archived);
  return useMemo(() => {
    const ids = space.sectionIds;
    return [
      ...spaceItems(space),
      ...Object.values(notes)
        .filter((note) => ids.has(note.space) && !(noteArchiveKey(note.id) in archived))
        .map(noteToItem),
    ].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [archived, notes, space]);
}
