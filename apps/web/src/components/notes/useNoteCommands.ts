/**
 * Note changes, each answering the notes after it or null when it failed,
 * with the server's reason (written for the user) in a toast.
 */
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import type { FolderLevel } from "@t3tools/contracts/signalboxFolders";
import type { NoteId, NoteVisibility } from "@t3tools/contracts/signalboxNotes";
import { useMemo } from "react";

import { signalboxNotes } from "../../state/signalboxNotes";
import { useAtomCommand } from "../../state/use-atom-command";
import { reported } from "../sidebar/folders/useFolderCommands";

export type NoteCommands = ReturnType<typeof useNoteCommands>;

export function useNoteCommands(environmentId: EnvironmentId) {
  const create = useAtomCommand(signalboxNotes.createNote, { reportFailure: false });
  const update = useAtomCommand(signalboxNotes.updateNote, { reportFailure: false });
  const remove = useAtomCommand(signalboxNotes.deleteNote, { reportFailure: false });
  const readAgain = useAtomCommand(signalboxNotes.readAgain, { reportFailure: false });
  const dismiss = useAtomCommand(signalboxNotes.dismissReading, { reportFailure: false });
  const accept = useAtomCommand(signalboxNotes.acceptNote, { reportFailure: false });

  return useMemo(
    () => ({
      create: (home: FolderLevel, text: string, visibility: NoteVisibility) =>
        reported(
          "Could not add note",
          create({ environmentId, input: { home, text, visibility } }),
        ),
      setVisibility: (id: NoteId, visibility: NoteVisibility) =>
        reported(
          visibility === "team" ? "Could not share note" : "Could not make note private",
          update({ environmentId, input: { id, visibility } }),
        ),
      remove: (id: NoteId) =>
        reported("Could not delete note", remove({ environmentId, input: { id } })),
      readAgain: (id: NoteId) =>
        reported("Could not read note again", readAgain({ environmentId, input: { id } })),
      dismiss: (id: NoteId) =>
        reported("Could not set that aside", dismiss({ environmentId, input: { id } })),
      /** Null `modelSelection` leaves the model to the server. */
      accept: (id: NoteId, modelSelection: ModelSelection | null) =>
        reported(
          "Could not start that",
          accept({
            environmentId,
            input: { id, ...(modelSelection === null ? {} : { modelSelection }) },
          }),
        ),
    }),
    [accept, create, dismiss, environmentId, readAgain, remove, update],
  );
}
