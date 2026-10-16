// signalbox: what the folder menus do: dialogs, confirmations, and the folder commands.
import { folderDeleteMessage } from "@t3tools/client-runtime/state/signalboxFolders";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  Folder,
  FolderId,
  FolderLevel,
  FolderSetPhaseInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { signalboxFolders } from "../../state/signalboxFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import { parseFolderMenuEvent, type PoolChoice } from "./folder-menus";

/** A level whose instructions are open in the editor. */
export interface InstructionsEditing {
  readonly level: FolderLevel;
  readonly name: string;
  readonly instructions: string;
}

/** A folder whose phases are open in the editor, and the template its tree starts from. */
export interface PhasesEditing {
  readonly folder: Folder;
  readonly ownerKind: SignalboxContext["kind"];
}

/** Runs a folder command and tells the user, in its own words, when it fails. */
export function useFolderCommandRunner() {
  return useCallback(
    async <A, E>(title: string, operation: Promise<AtomCommandResult<A, E>>): Promise<boolean> => {
      const result = await operation;
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          title,
          error instanceof Error && error.message.trim() ? error.message : "Try again in a moment.",
        );
      }
      return false;
    },
    [],
  );
}

const QUIET = { reportFailure: false } as const;

export function useFolderActions(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: SignalboxFoldersSnapshot | null;
  readonly pools: ReadonlyArray<PoolChoice>;
  /** Whose trees the folders are in, for the phases template a folder starts from. */
  readonly owners: ReadonlyArray<SignalboxContext>;
}) {
  const { environmentId, snapshot, pools, owners } = input;
  const run = useFolderCommandRunner();
  const createFolder = useAtomCommand(signalboxFolders.createFolder, QUIET);
  const updateFolder = useAtomCommand(signalboxFolders.updateFolder, QUIET);
  const moveFolder = useAtomCommand(signalboxFolders.moveFolder, QUIET);
  const deleteFolder = useAtomCommand(signalboxFolders.deleteFolder, QUIET);
  const setInstructions = useAtomCommand(signalboxFolders.setInstructions, QUIET);
  const setPhase = useAtomCommand(signalboxFolders.setPhase, QUIET);
  const [editing, setEditing] = useState<InstructionsEditing | null>(null);
  const [editingPhases, setEditingPhases] = useState<PhasesEditing | null>(null);

  const requestCreateFolder = useCallback(
    (parentId: FolderId | null, ownerId: SignalboxContextId) => {
      Dialog.prompt({
        title: "New folder",
        initialValue: "",
        confirmText: "Create",
        onConfirm: (name) => {
          void run(
            "Couldn’t create the folder",
            createFolder({
              environmentId,
              input: parentId === null ? { name, parentId, ownerId } : { name, parentId },
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
      const choice = parseFolderMenuEvent({ snapshot, folder, pools, event });
      if (choice === null) return;
      switch (choice._tag) {
        case "newChild":
          requestCreateFolder(folder.id, folder.ownerId);
          return;
        case "rename":
          Dialog.prompt({
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
        case "phase":
          void run(
            "Couldn’t change this folder’s phase",
            setPhase({ environmentId, input: { id: folder.id, current: choice.current } }),
          );
          return;
        case "phases":
          setEditingPhases({
            folder,
            ownerKind: owners.find((owner) => owner.id === folder.ownerId)?.kind ?? "personal",
          });
          return;
        case "instructions":
          setEditing({
            level: { _tag: "folder", folderId: folder.id },
            name: folder.name,
            instructions: folder.instructions ?? "",
          });
          return;
        case "delete":
          Dialog.confirm({
            title: `Delete ${folder.name}?`,
            message: folderDeleteMessage(snapshot, folder),
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
    [
      deleteFolder,
      environmentId,
      moveFolder,
      owners,
      pools,
      requestCreateFolder,
      run,
      setPhase,
      snapshot,
      updateFolder,
    ],
  );

  const onTopLevelAction = useCallback(
    (owner: SignalboxContext, event: string) => {
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
      if (editing === null || instructions === editing.instructions) return true;
      return run(
        "Couldn’t save the instructions",
        setInstructions({ environmentId, input: { level: editing.level, instructions } }),
      );
    },
    [editing, environmentId, run, setInstructions],
  );

  /** Saves the open phases editor's change; resolves whether it was saved. */
  const savePhases = useCallback(
    (change: Omit<FolderSetPhaseInput, "id">) =>
      editingPhases === null
        ? Promise.resolve(true)
        : run(
            "Couldn’t save the phases",
            setPhase({ environmentId, input: { id: editingPhases.folder.id, ...change } }),
          ),
    [editingPhases, environmentId, run, setPhase],
  );

  return {
    onFolderAction,
    onTopLevelAction,
    editing,
    closeEditor: useCallback(() => setEditing(null), []),
    saveInstructions,
    editingPhases,
    closePhasesEditor: useCallback(() => setEditingPhases(null), []),
    savePhases,
  };
}
