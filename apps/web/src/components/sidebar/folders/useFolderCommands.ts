/**
 * Folder changes, each answering the tree after it or null when it failed.
 * A failure shows the server's reason, which is written for the user.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { AccountPoolId } from "@t3tools/contracts/accountHub";
import type {
  Folder,
  FolderCreateInput,
  FolderId,
  FolderLevel,
  FolderMoveInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { useMemo } from "react";

import { signalboxFolders } from "../../../state/signalboxFolders";
import { useAtomCommand } from "../../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../../ui/toast";

type Change = Promise<SignalboxFoldersSnapshot | null>;

async function reported<E>(
  title: string,
  command: Promise<AtomCommandResult<SignalboxFoldersSnapshot, E>>,
): Change {
  const result = await command;
  if (result._tag === "Success") return result.value;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
  return null;
}

export function useFolderCommands() {
  const create = useAtomCommand(signalboxFolders.createFolder, { reportFailure: false });
  const update = useAtomCommand(signalboxFolders.updateFolder, { reportFailure: false });
  const move = useAtomCommand(signalboxFolders.moveFolder, { reportFailure: false });
  const remove = useAtomCommand(signalboxFolders.deleteFolder, { reportFailure: false });
  const moveThread = useAtomCommand(signalboxFolders.moveThread, { reportFailure: false });
  const setInstructions = useAtomCommand(signalboxFolders.setInstructions, {
    reportFailure: false,
  });

  return useMemo(
    () => ({
      create: (environmentId: EnvironmentId, input: FolderCreateInput): Change =>
        reported("Could not create folder", create({ environmentId, input })),
      rename: (environmentId: EnvironmentId, id: FolderId, name: string): Change =>
        reported("Could not rename folder", update({ environmentId, input: { id, name } })),
      /** Null inherits the pool from above again. */
      setPool: (environmentId: EnvironmentId, id: FolderId, poolId: AccountPoolId | null): Change =>
        reported(
          "Could not change this folder's pool",
          update({ environmentId, input: { id, poolId } }),
        ),
      /** Null leaves the folder without files of its own. */
      setFiles: (environmentId: EnvironmentId, id: FolderId, files: ProjectId | null): Change =>
        reported(
          "Could not change this folder's files",
          update({ environmentId, input: { id, files } }),
        ),
      move: (environmentId: EnvironmentId, input: FolderMoveInput): Change =>
        reported("Could not move folder", move({ environmentId, input })),
      remove: (environmentId: EnvironmentId, folder: Folder): Change =>
        reported("Could not delete folder", remove({ environmentId, input: { id: folder.id } })),
      moveThread: (
        environmentId: EnvironmentId,
        threadId: ThreadId,
        folderId: FolderId | null,
      ): Change =>
        reported(
          "Could not move thread",
          moveThread({ environmentId, input: { threadId, folderId } }),
        ),
      setInstructions: (
        environmentId: EnvironmentId,
        level: FolderLevel,
        instructions: string,
      ): Change =>
        reported(
          "Could not save instructions",
          setInstructions({ environmentId, input: { level, instructions } }),
        ),
    }),
    [create, move, moveThread, remove, setInstructions, update],
  );
}

export type FolderCommands = ReturnType<typeof useFolderCommands>;
