// signalbox: a new-task draft's folder home lives beside its durable project stamp.
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import {
  isComposerDraftEmpty,
  setNewTaskDraftFolderStart,
  useComposerDraft,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import type { FolderStart } from "./folder-filter";
import type { PoolHome } from "./folder-pool";
import { useNewTaskFolderStart } from "./use-folder-filter";
import { restoredDraftFolderStart } from "./restored-draft-folder";

/** A new task's folders: where one starts now, and where this draft goes. */
export interface NewTaskFolders {
  /** Where a new task starts while the thread list shows a folder. */
  readonly start: FolderStart | null;
  /** The folder this draft is filed in when it's sent. */
  readonly target: FolderStart | null;
  /** What its pool resolves by: the target folder. */
  readonly poolHome: PoolHome | undefined;
}


export function useNewTaskFolders(
  draftKey: string | null,
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null,
): NewTaskFolders {
  const start = useNewTaskFolderStart();
  const draft = useComposerDraft(draftKey);
  const target = useDraftFolder({ draftKey, start, project, draft });
  return useMemo(
    () => ({ start, target, poolHome: target ? { folderId: target.folderId } : undefined }),
    [start, target],
  );
}

/**
 * First-open seeds the current folder on an empty draft; capture writes its
 * explicit choice directly. A resumed draft keeps that start across restarts.
 */
function useDraftFolder(input: {
  readonly draftKey: string | null;
  readonly start: FolderStart | null;
  readonly project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null;
  readonly draft: ComposerDraft;
}): FolderStart | null {
  const { draftKey, start, project, draft } = input;
  const stamp = draft.project;

  useEffect(() => {
    if (
      draftKey === null ||
      start === null ||
      project === null ||
      !stamp ||
      stamp.folderStart !== undefined ||
      !isComposerDraftEmpty(draft) ||
      project.environmentId !== stamp.environmentId ||
      project.id !== stamp.projectId ||
      start.environmentId !== stamp.environmentId ||
      start.projectId !== stamp.projectId
    ) {
      return;
    }
    setNewTaskDraftFolderStart(draftKey, start);
  }, [draft, draftKey, project, stamp, start]);

  return useMemo(() => restoredDraftFolderStart(stamp, project), [project, stamp]);
}
