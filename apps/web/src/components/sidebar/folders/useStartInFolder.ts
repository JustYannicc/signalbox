/**
 * Starts a thread in a folder: a draft in the folder's files (or its owner's
 * own), filed there when it lives somewhere else, on the folder's pool. With
 * `openFiles` it also opens the draft's Files panel, which is how a folder's
 * files are browsed; with `prompt` the draft starts with that request typed.
 */
import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  homeOfThread,
  newThreadIn,
  poolOfHome,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AccountPoolId } from "@t3tools/contracts/accountHub";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { useCallback, useContext } from "react";

import { type DraftId, useComposerDraftStore } from "../../../composerDraftStore";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { hasExplicitComposerModelSelection } from "../../../lib/chatThreadActions";
import { useRightPanelStore } from "../../../rightPanelStore";
import { draftModelSelection } from "../../../state/projectPool";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { projectSettingsIn, selectionOnPool } from "./homeModelSelection";
import { useFolderCommands } from "./useFolderCommands";

export interface StartInFolder {
  readonly environmentId: EnvironmentId;
  /** The owner's own files, for a folder without files of its own; null when it has none. */
  readonly ownerProjectId: ProjectId | null;
  readonly folderId: FolderId | null;
  readonly openFiles?: boolean;
  readonly prompt?: string;
}

export function useStartInFolder() {
  const registry = useContext(RegistryContext);
  const handleNewThread = useNewThreadHandler();
  const commands = useFolderCommands();

  /** Moves a draft's model onto the pool of the folder it's in, unless the user picked one. */
  const followPool = useCallback(
    (
      draftId: DraftId,
      environmentId: EnvironmentId,
      projectId: ProjectId,
      poolId: AccountPoolId,
    ) => {
      const { getComposerDraft, setModelSelection } = useComposerDraftStore.getState();
      const draft = getComposerDraft(draftId);
      if (hasExplicitComposerModelSelection(draft)) return;
      const config = registry.get(environmentServerConfigsAtom).get(environmentId);
      const selection = selectionOnPool({
        config,
        settings: projectSettingsIn(config, environmentId, projectId),
        selection: draftModelSelection(draft),
        poolId,
      });
      if (selection) setModelSelection(draftId, selection, { replaceOptions: true });
    },
    [registry],
  );

  return useCallback(
    async (input: StartInFolder) => {
      const snapshotNow = () =>
        registry.get(environmentFoldersAtom).get(input.environmentId)?.snapshot ?? null;
      const before = snapshotNow();
      if (before === null) return;
      const ownerProjectId =
        input.ownerProjectId ??
        before.folders.find((folder) => folder.id === input.folderId)?.files?.projectId;
      if (ownerProjectId === undefined) return;
      const { projectId } = newThreadIn(before, input.folderId, ownerProjectId);
      const result = await settlePromise(() =>
        // Folders without files share their owner's project, so its empty draft may be
        // another folder's: always a draft of this folder's own.
        handleNewThread(scopeProjectRef(input.environmentId, projectId), { freshDraft: true }),
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
      // Read the tree again: it may have changed while the draft opened. For a fresh draft this
      // is `newThreadIn(...).file`; it also catches an empty draft reused from another folder.
      const latest = snapshotNow() ?? before;
      const filed =
        homeOfThread(latest, { id: opened.threadId, projectId }) === input.folderId
          ? latest
          : await commands.moveThread(input.environmentId, opened.threadId, input.folderId);
      // The draft picked its pool by its project; it runs on its folder's.
      const pool = filed && poolOfHome(filed, input.folderId);
      if (pool) followPool(opened.draftId, input.environmentId, projectId, pool.poolId);
      if (input.prompt) useComposerDraftStore.getState().setPrompt(opened.draftId, input.prompt);
      if (input.openFiles) {
        useRightPanelStore
          .getState()
          .open(scopeThreadRef(input.environmentId, opened.threadId), "files");
      }
    },
    [commands, followPool, handleNewThread, registry],
  );
}
