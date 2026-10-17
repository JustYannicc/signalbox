/**
 * The one notes pad open at a time. Folder menus and the command palette open
 * it; `NotesSheet`, mounted once with the app shell, shows it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { FolderLevel } from "@t3tools/contracts/signalboxFolders";
import { create } from "zustand";

export interface NotesPad {
  readonly environmentId: EnvironmentId;
  readonly home: FolderLevel;
}

/** `shown` stays the last pad while it closes; `openCount` tells each opening apart. */
export const useNotesSheetStore = create<{
  readonly pad: NotesPad | null;
  readonly shown: NotesPad | null;
  readonly openCount: number;
}>(() => ({ pad: null, shown: null, openCount: 0 }));

export const openNotes = (pad: NotesPad) =>
  useNotesSheetStore.setState((state) => ({ pad, shown: pad, openCount: state.openCount + 1 }));

export const closeNotes = () => useNotesSheetStore.setState({ pad: null });
