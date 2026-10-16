// signalbox: what the notes sheet does: writing, sharing, deleting, and turning an offer into work.
import { noteOffer } from "@t3tools/client-runtime/state/signalboxNotes";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FolderLevel } from "@t3tools/contracts/signalboxFolders";
import type { Note, NoteVisibility } from "@t3tools/contracts/signalboxNotes";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { signalboxNotes } from "../../state/signalboxNotes";
import { useAtomCommand } from "../../state/use-atom-command";
import { useFolderCommandRunner } from "../folders/use-folder-actions";
import { parseNoteMenuEvent } from "./note-menus";
import { useNoteModelSelection } from "./use-note-model-selection";

const QUIET = { reportFailure: false } as const;

export function useNoteActions(input: {
  readonly environmentId: EnvironmentId;
  readonly level: FolderLevel;
}) {
  const { environmentId, level } = input;
  const run = useFolderCommandRunner();
  const createNote = useAtomCommand(signalboxNotes.createNote, QUIET);
  const updateNote = useAtomCommand(signalboxNotes.updateNote, QUIET);
  const deleteNote = useAtomCommand(signalboxNotes.deleteNote, QUIET);
  const readAgain = useAtomCommand(signalboxNotes.readAgain, QUIET);
  const dismissReading = useAtomCommand(signalboxNotes.dismissReading, QUIET);
  const acceptNote = useAtomCommand(signalboxNotes.acceptNote, QUIET);
  const modelSelection = useNoteModelSelection(environmentId, level);

  /** Resolves whether it was added, so the composer only clears what was kept. */
  const add = useCallback(
    async (text: string, visibility: NoteVisibility) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return run(
        "Couldn’t add the note",
        createNote({
          environmentId,
          input: level._tag === "top" ? { home: level, text } : { home: level, text, visibility },
        }),
      );
    },
    [createNote, environmentId, level, run],
  );

  const onNoteAction = useCallback(
    (note: Note, event: string) => {
      const choice = parseNoteMenuEvent(note, event);
      if (choice === null) return;
      const id = { id: note.id };
      switch (choice._tag) {
        case "readAgain":
          void run("Couldn’t read the note again", readAgain({ environmentId, input: id }));
          return;
        case "visibility":
          void run(
            choice.visibility === "team"
              ? "Couldn’t share the note"
              : "Couldn’t make the note private",
            updateNote({ environmentId, input: { ...id, visibility: choice.visibility } }),
          );
          return;
        case "delete":
          Dialog.confirm({
            title: "Delete this note?",
            message: "It’s gone for good.",
            confirmText: "Delete",
            destructive: true,
            onConfirm: () => {
              void run("Couldn’t delete the note", deleteNote({ environmentId, input: id }));
            },
          });
      }
    },
    [deleteNote, environmentId, readAgain, run, updateNote],
  );

  const dismiss = useCallback(
    (note: Note) =>
      void run(
        "Couldn’t set the offer aside",
        dismissReading({ environmentId, input: { id: note.id } }),
      ),
    [dismissReading, environmentId, run],
  );

  /** Starts the offered work; resolves the new task's thread, or null when it didn't start. */
  const accept = useCallback(
    async (note: Note): Promise<ThreadId | null> => {
      if (noteOffer(note) === null) return null;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const result = await acceptNote({
        environmentId,
        input: modelSelection === null ? { id: note.id } : { id: note.id, modelSelection },
      });
      if (result._tag === "Success") return result.value.threadId;
      await run("Couldn’t start the work", Promise.resolve(result));
      return null;
    },
    [acceptNote, environmentId, modelSelection, run],
  );

  return { add, onNoteAction, dismiss, accept };
}
