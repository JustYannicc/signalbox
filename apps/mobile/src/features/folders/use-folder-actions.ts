// signalbox: what the folder menus do: dialogs, confirmations, and the folder commands.
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  Folder,
  FolderId,
  FolderLevel,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import { showConfirmDialog, showTextInputDialog } from "../../components/ConfirmDialogHost";
import { signalboxFolders } from "../../state/signalboxFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import { deleteFolderMessage, parseFolderMenuEvent } from "./folder-menus";

/** A level whose instructions are open in the editor. */
export interface InstructionsEditing {
  readonly level: FolderLevel;
  readonly name: string;
  readonly instructions: string;
}

/** Runs a folder command and tells the user, in its own words, when it fails. */
export function useFolderCommandRunner() {
  return useCallback(
    async <A, E>(title: string, operation: Promise<AtomCommandResult<A, E>>): Promise<boolean> => {
      const result = await operation;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            title,
            error instanceof Error && error.message.trim()
              ? error.message
              : "Try again in a moment.",
          );
        }
        return false;
      }
      return result._tag === "Success";
    },
    [],
  );
}

export function useFolderActions(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: SignalboxFoldersSnapshot | null;
}) {
  const { environmentId, snapshot } = input;
  const run = useFolderCommandRunner();
  const options = { reportFailure: false } as const;
  const createFolder = useAtomCommand(signalboxFolders.createFolder, options);
  const updateFolder = useAtomCommand(signalboxFolders.updateFolder, options);
  const moveFolder = useAtomCommand(signalboxFolders.moveFolder, options);
  const deleteFolder = useAtomCommand(signalboxFolders.deleteFolder, options);
  const setInstructions = useAtomCommand(signalboxFolders.setInstructions, options);
  const [editing, setEditing] = useState<InstructionsEditing | null>(null);

  const requestCreateFolder = useCallback(
    (parentId: FolderId | null, ownerId: string) => {
      showTextInputDialog({
        title: "New folder",
        initialValue: "",
        confirmText: "Create",
        onConfirm: (name) => {
          void run(
            "Couldn’t create the folder",
            createFolder({
              environmentId,
              input:
                parentId === null
                  ? { name, parentId, ownerId: SignalboxContextId.make(ownerId) }
                  : { name, parentId },
            }),
          );
        },
      });
    },
    [createFolder, environmentId, run],
  );

  const onFolderAction = useCallback(
    (folder: Folder, event: string) => {
      if (snapshot === null) return;
      const choice = parseFolderMenuEvent(snapshot, folder, event);
      if (choice === null) return;
      switch (choice._tag) {
        case "newChild":
          requestCreateFolder(folder.id, folder.ownerId);
          return;
        case "rename":
          showTextInputDialog({
            title: "Rename folder",
            initialValue: folder.name,
            confirmText: "Save",
            onConfirm: (name) => {
              if (name.trim() === folder.name) return;
              void run(
                "Couldn’t rename the folder",
                updateFolder({ environmentId, input: { id: folder.id, name } }),
              );
            },
          });
          return;
        case "move":
          void run("Couldn’t move the folder", moveFolder({ environmentId, input: choice.input }));
          return;
        case "pool":
          void run(
            "Couldn’t change this folder’s pool",
            updateFolder({ environmentId, input: { id: folder.id, poolId: choice.poolId } }),
          );
          return;
        case "instructions":
          setEditing({
            level: { _tag: "folder", folderId: folder.id },
            name: folder.name,
            instructions: folder.instructions ?? "",
          });
          return;
        case "delete":
          showConfirmDialog({
            title: `Delete ${folder.name}?`,
            message: deleteFolderMessage(snapshot, folder),
            confirmText: "Delete",
            destructive: true,
            onConfirm: () => {
              void run(
                "Couldn’t delete the folder",
                deleteFolder({ environmentId, input: { id: folder.id } }),
              );
            },
          });
      }
    },
    [deleteFolder, environmentId, moveFolder, requestCreateFolder, run, snapshot, updateFolder],
  );

  const onTopLevelAction = useCallback(
    (owner: { readonly id: string; readonly name: string }, event: string) => {
      if (event === "top:new-folder") requestCreateFolder(null, owner.id);
      if (event === "top:instructions" && snapshot !== null) {
        setEditing({
          level: { _tag: "top" },
          name: owner.name,
          instructions: snapshot.top.instructions ?? "",
        });
      }
    },
    [requestCreateFolder, snapshot],
  );

  /** Saves the open editor's text; resolves whether it was saved. */
  const saveInstructions = useCallback(
    async (instructions: string) => {
      if (editing === null) return true;
      if (instructions === editing.instructions) return true;
      return run(
        "Couldn’t save the instructions",
        setInstructions({ environmentId, input: { level: editing.level, instructions } }),
      );
    },
    [editing, environmentId, run, setInstructions],
  );

  return {
    requestCreateFolder,
    onFolderAction,
    onTopLevelAction,
    editing,
    closeEditor: useCallback(() => setEditing(null), []),
    saveInstructions,
  };
}
