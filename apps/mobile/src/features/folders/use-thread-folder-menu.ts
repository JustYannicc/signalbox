// signalbox: "Move to folder" in a thread's menu, where its environment keeps folders.
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { useCallback, useMemo } from "react";

import {
  signalboxFolders,
  useEnvironmentFolders,
  useFolderOwners,
} from "../../state/signalboxFolders";
import { useAtomCommand } from "../../state/use-atom-command";
import { folderResidency } from "./folder-filter";
import { parseThreadFolderMenuEvent, threadFolderMenuActions } from "./folder-menus";
import { useFolderCommandRunner } from "./use-folder-actions";

const NO_ACTIONS: MenuAction[] = [];

/**
 * The thread's menu items and a handler that returns whether it took the
 * choice. Empty where folders don't exist or the owner has none yet.
 */
export function useThreadFolderMenu(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}) {
  const snapshot = useEnvironmentFolders(thread.environmentId).data;
  const owners = useFolderOwners(thread.environmentId);
  const moveThread = useAtomCommand(signalboxFolders.moveThread, { reportFailure: false });
  const run = useFolderCommandRunner();
  const { environmentId, id, projectId } = thread;
  const placement = useMemo(() => {
    if (!snapshot) return null;
    const residency = folderResidency(snapshot, owners);
    const resident = { id, projectId };
    const ownerId = residency.ownerOf(resident);
    return ownerId === undefined ? null : { snapshot, ownerId, home: residency.homeOf(resident) };
  }, [id, owners, projectId, snapshot]);
  const items = useMemo(
    () => (placement ? threadFolderMenuActions(placement) : NO_ACTIONS),
    [placement],
  );
  const onAction = useCallback(
    (event: string): boolean => {
      if (!placement || !event.startsWith("thread-folder")) return false;
      const target = parseThreadFolderMenuEvent(placement, event);
      if (target !== undefined) {
        void run(
          "Couldn’t move the thread",
          moveThread({ environmentId, input: { threadId: id, folderId: target.folderId } }),
        );
      }
      return true;
    },
    [environmentId, id, moveThread, placement, run],
  );
  return { items, onAction };
}

/** Files a thread that's about to start in its folder; resolves whether it was filed. */
export function useFileNewThreadInFolder() {
  const moveThread = useAtomCommand(signalboxFolders.moveThread, { reportFailure: false });
  const run = useFolderCommandRunner();
  return useCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly folderId: FolderId | null;
      readonly folderName: string;
    }) =>
      run(
        `Couldn’t start it in ${input.folderName}`,
        moveThread({
          environmentId: input.environmentId,
          input: { threadId: input.threadId, folderId: input.folderId },
        }),
      ),
    [moveThread, run],
  );
}
