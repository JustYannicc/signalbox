/**
 * Folder changes, each answering the tree after it or null when it failed.
 * A failure shows the server's reason, which is written for the user: in a
 * toast, or (`Attempt`) for the dialog that made it to show inline.
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
  FolderSetPhaseInput,
  OnePasswordEnvironmentId,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

import { signalboxFolders } from "../../../state/signalboxFolders";
import { useAtomCommand } from "../../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../../ui/toast";

type Change = Promise<SignalboxFoldersSnapshot | null>;

/** The command's value, or null after toasting why it failed (`title` says what didn't happen). */
export async function reported<A, E>(
  title: string,
  command: Promise<AtomCommandResult<A, E>>,
): Promise<A | null> {
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

/** Null when it worked; else why not, or null too when it was cut off (nothing to show). */
export type Attempt = Promise<{ readonly error: string | null } | null>;

async function attempted<E>(
  command: Promise<AtomCommandResult<SignalboxFoldersSnapshot, E>>,
): Attempt {
  const result = await command;
  if (result._tag === "Success") return null;
  if (isAtomCommandInterrupted(result)) return { error: null };
  const error = squashAtomCommandFailure(result);
  return { error: error instanceof Error ? error.message : "An error occurred." };
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
  const setPhase = useAtomCommand(signalboxFolders.setPhase, { reportFailure: false });
  const setSecrets = useAtomCommand(signalboxFolders.setSecrets, { reportFailure: false });
  const setGitHubLend = useAtomCommand(signalboxFolders.setGitHubLend, { reportFailure: false });
  const setOnePassword = useAtomCommand(signalboxFolders.setOnePassword, {
    reportFailure: false,
  });

  return {
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
    /** Lends the user's GitHub to the folder's CI steps (#641), or stops lending it. */
    setGitHubLend: (environmentId: EnvironmentId, id: FolderId, lent: boolean): Change =>
      reported(
        lent ? "Could not lend your GitHub" : "Could not stop lending your GitHub",
        setGitHubLend({ environmentId, input: { id, lent } }),
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
    /** Moves it to another phase, replaces its phases, or (`phases: null`) clears them. */
    setPhase: (environmentId: EnvironmentId, input: FolderSetPhaseInput): Change =>
      reported("Could not change this folder's phase", setPhase({ environmentId, input })),
    /** Null stops loading secrets at this level. */
    setSecrets: (
      environmentId: EnvironmentId,
      level: FolderLevel,
      secretsEnvironmentId: OnePasswordEnvironmentId | null,
    ): Attempt =>
      attempted(
        setSecrets({
          environmentId,
          input: {
            level,
            secrets: secretsEnvironmentId === null ? null : { environmentId: secretsEnvironmentId },
          },
        }),
      ),
    /** The user's service account token, for every level; null disconnects it. */
    setOnePassword: (environmentId: EnvironmentId, token: string | null): Attempt =>
      attempted(setOnePassword({ environmentId, input: { token } })),
  };
}

export type FolderCommands = ReturnType<typeof useFolderCommands>;
