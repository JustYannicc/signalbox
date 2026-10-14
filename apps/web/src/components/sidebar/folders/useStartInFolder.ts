/**
 * Starts a thread in a folder: a draft in the folder's files (or its owner's
 * own), filed there when its project's threads live somewhere else, on the
 * folder's pool. With `openFiles` it also opens the draft's Files panel,
 * which is how a folder's files are browsed.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { poolModelSelection } from "@t3tools/client-runtime/state/sections";
import {
  homeOfThread,
  newThreadIn,
  poolOfHome,
} from "@t3tools/client-runtime/state/signalboxFolders";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback } from "react";

import { type DraftId, useComposerDraftStore } from "../../../composerDraftStore";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { hasExplicitComposerModelSelection } from "../../../lib/chatThreadActions";
import { useRightPanelStore } from "../../../rightPanelStore";
import { readProjects } from "../../../state/entities";
import { draftModelSelection } from "../../../state/projectPool";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useFolderCommands } from "./useFolderCommands";

export interface StartInFolder {
  readonly environmentId: EnvironmentId;
  /** The owner's own files, for a folder without files of its own; null when it has none. */
  readonly ownerProjectId: ProjectId | null;
  readonly folderId: FolderId | null;
  readonly openFiles?: boolean;
}

export function useStartInFolder() {
  const handleNewThread = useNewThreadHandler();
  const commands = useFolderCommands();
  const folders = useAtomValue(environmentFoldersAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);

  /** Moves a draft's model onto the pool of the folder it was just filed in, unless the user picked one. */
  const followPool = useCallback(
    (draftId: DraftId, environmentId: EnvironmentId, projectId: ProjectId, poolId: string) => {
      const { getComposerDraft, setModelSelection } = useComposerDraftStore.getState();
      const draft = getComposerDraft(draftId);
      if (hasExplicitComposerModelSelection(draft)) return;
      const config = configs.get(environmentId);
      const project = readProjects().find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
      );
      const settings = resolveProjectSettings(
        config?.settings ?? DEFAULT_SERVER_SETTINGS,
        projectId,
        project,
      ).settings;
      const selection = poolModelSelection({
        selection: draftModelSelection(draft),
        pool: { poolId },
        providerInstances: settings.providerInstances,
        providers: config?.providers ?? [],
      });
      if (selection) setModelSelection(draftId, selection, { replaceOptions: true });
    },
    [configs],
  );

  return useCallback(
    async (input: StartInFolder) => {
      const snapshot = folders.get(input.environmentId)?.snapshot;
      if (!snapshot) return;
      const ownerProjectId =
        input.ownerProjectId ??
        snapshot.folders.find((folder) => folder.id === input.folderId)?.files?.projectId;
      if (ownerProjectId === undefined) return;
      const { projectId } = newThreadIn(snapshot, input.folderId, ownerProjectId);
      const result = await settlePromise(() =>
        handleNewThread(scopeProjectRef(input.environmentId, projectId)),
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const opened = result.value;
      if (opened === null) return;
      // A reused draft may have been filed elsewhere before, so check its home, not only its project's.
      const filed =
        homeOfThread(snapshot, { id: opened.threadId, projectId }) === input.folderId
          ? snapshot
          : await commands.moveThread(input.environmentId, opened.threadId, input.folderId);
      // The new thread picked its pool by its project; it runs on its folder's.
      const pool = filed && poolOfHome(filed, input.folderId);
      if (pool) followPool(opened.draftId, input.environmentId, projectId, pool.poolId);
      if (input.openFiles) {
        useRightPanelStore
          .getState()
          .open(scopeThreadRef(input.environmentId, opened.threadId), "files");
      }
    },
    [commands, folders, followPool, handleNewThread],
  );
}
