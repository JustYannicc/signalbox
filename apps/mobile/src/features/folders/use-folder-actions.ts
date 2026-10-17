// signalbox: what the folder menus do: dialogs, confirmations, and the folder commands.
import {
  folderDeleteMessage,
  ownerLevelName,
} from "@t3tools/client-runtime/state/signalboxFolders";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { secretSourcesAbove, type SecretsSave } from "@t3tools/client-runtime/state/folderSecrets";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  Folder,
  FolderId,
  FolderLevel,
  FolderSecrets,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { signalboxFolders } from "../../state/signalboxFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import type { NotesOpen } from "../notes/note-menus";
import { parseFolderMenuEvent, type PoolChoice } from "./folder-menus";

/** A level whose instructions are open in the editor. */
export interface InstructionsEditing {
  readonly level: FolderLevel;
  readonly name: string;
  readonly instructions: string;
}

/** A level's Secrets settings open from its native folder menu. */
export interface SecretsEditing {
  readonly level: FolderLevel;
  readonly name: string;
  readonly secrets: FolderSecrets | null;
  readonly onePasswordConnected: boolean;
  readonly ancestorSources: ReadonlyArray<string>;
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
}) {
  const { environmentId, snapshot, pools } = input;
  const run = useFolderCommandRunner();
  const createFolder = useAtomCommand(signalboxFolders.createFolder, QUIET);
  const updateFolder = useAtomCommand(signalboxFolders.updateFolder, QUIET);
  const moveFolder = useAtomCommand(signalboxFolders.moveFolder, QUIET);
  const deleteFolder = useAtomCommand(signalboxFolders.deleteFolder, QUIET);
  const setInstructions = useAtomCommand(signalboxFolders.setInstructions, QUIET);
  const setSecrets = useAtomCommand(signalboxFolders.setSecrets, QUIET);
  const setOnePassword = useAtomCommand(signalboxFolders.setOnePassword, QUIET);
  const setGitHubLend = useAtomCommand(signalboxFolders.setGitHubLend, QUIET);
  const [editing, setEditing] = useState<InstructionsEditing | null>(null);
  const [editingSecrets, setEditingSecrets] = useState<SecretsEditing | null>(null);
  const [notes, setNotes] = useState<NotesOpen | null>(null);

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
        case "githubLend":
          void run(
            choice.lent ? "Couldn’t lend your GitHub" : "Couldn’t stop lending your GitHub",
            setGitHubLend({ environmentId, input: { id: folder.id, lent: choice.lent } }),
          );
          return;
        case "instructions":
          setEditing({
            level: { _tag: "folder", folderId: folder.id },
            name: folder.name,
            instructions: folder.instructions ?? "",
          });
          return;
        case "secrets":
          setEditingSecrets({
            level: { _tag: "folder", folderId: folder.id },
            name: folder.name,
            secrets: folder.secrets ?? null,
            onePasswordConnected: snapshot.onePassword?.connectedAt != null,
            ancestorSources: secretSourcesAbove(snapshot, {
              _tag: "folder",
              folderId: folder.id,
            }),
          });
          return;
        case "notes":
          setNotes({ environmentId, level: { _tag: "folder", folderId: folder.id } });
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
      pools,
      requestCreateFolder,
      run,
      setGitHubLend,
      snapshot,
      updateFolder,
    ],
  );

  const onTopLevelAction = useCallback(
    (owner: SignalboxContext, event: string) => {
      if (event === "top:new-folder") requestCreateFolder(null, owner.id);
      if (event === "top:notes") setNotes({ environmentId, level: { _tag: "top" } });
      if (event === "top:instructions" && snapshot !== null) {
        setEditing({
          level: { _tag: "top" },
          name: ownerLevelName(owner),
          instructions: snapshot.top.instructions ?? "",
        });
      }
      if (event === "top:secrets" && snapshot !== null) {
        setEditingSecrets({
          level: { _tag: "top" },
          name: ownerLevelName(owner),
          secrets: snapshot.top.secrets ?? null,
          onePasswordConnected: snapshot.onePassword?.connectedAt != null,
          ancestorSources: [],
        });
      }
    },
    [environmentId, requestCreateFolder, snapshot],
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

  const saveSecrets = useCallback(
    async (plan: SecretsSave, onConnected: () => void) => {
      if (editingSecrets === null || "error" in plan) return false;
      if (
        plan.connect !== null &&
        !(await run(
          "Couldn't connect 1Password",
          setOnePassword({ environmentId, input: { token: plan.connect } }),
        ))
      ) {
        return false;
      }
      if (plan.connect !== null) {
        setEditingSecrets((current) =>
          current === null ? null : { ...current, onePasswordConnected: true },
        );
        onConnected();
      }
      return plan.secrets === undefined
        ? true
        : run(
            "Couldn't save secrets",
            setSecrets({
              environmentId,
              input: { level: editingSecrets.level, secrets: plan.secrets },
            }),
          );
    },
    [editingSecrets, environmentId, run, setOnePassword, setSecrets],
  );

  const removeSecrets = useCallback(() => {
    if (editingSecrets === null) return Promise.resolve(false);
    return run(
      "Couldn't remove secrets",
      setSecrets({ environmentId, input: { level: editingSecrets.level, secrets: null } }),
    );
  }, [editingSecrets, environmentId, run, setSecrets]);

  const disconnectOnePassword = useCallback(async () => {
    if (editingSecrets === null || !editingSecrets.onePasswordConnected) return false;
    const disconnected = await run(
      "Couldn't disconnect 1Password",
      setOnePassword({ environmentId, input: { token: null } }),
    );
    if (disconnected) {
      setEditingSecrets((current) =>
        current === null ? null : { ...current, onePasswordConnected: false },
      );
    }
    return disconnected;
  }, [editingSecrets, environmentId, run, setOnePassword]);

  return {
    onFolderAction,
    onTopLevelAction,
    editing,
    closeEditor: useCallback(() => setEditing(null), []),
    editingSecrets,
    closeSecretsEditor: useCallback(() => setEditingSecrets(null), []),
    saveSecrets,
    removeSecrets,
    disconnectOnePassword,
    notes,
    closeNotes: useCallback(() => setNotes(null), []),
    saveInstructions,
  };
}
