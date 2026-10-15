// signalbox: the folder a new-task draft starts in, recorded when the draft is made.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { getComposerDraftSnapshot, isComposerDraftEmpty } from "../../state/use-composer-drafts";
import type { FolderStart } from "./folder-filter";
import type { PoolHome } from "./folder-pool";
import { useNewTaskFolderStart } from "./use-folder-filter";

/**
 * Each draft's folder by draft key. In memory: a draft resumed after the app
 * restarts starts where its project's threads live.
 */
const draftFoldersAtom = Atom.make<ReadonlyMap<string, FolderStart>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("signalbox:draft-folders"),
);

/** Records `start` for `draftKey` unless the draft already has a folder or content of its own. */
function recordDraftFolder(draftKey: string, start: FolderStart) {
  const current = appAtomRegistry.get(draftFoldersAtom);
  if (current.has(draftKey) || !isComposerDraftEmpty(getComposerDraftSnapshot(draftKey))) return;
  appAtomRegistry.set(draftFoldersAtom, new Map([...current, [draftKey, start]]));
}

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
  const target = useDraftFolder({ draftKey, start, project });
  return useMemo(
    () => ({ start, target, poolHome: target ? { folderId: target.folderId } : undefined }),
    [start, target],
  );
}

/**
 * The folder the draft is filed in when it's sent: the one shown when it was
 * made (`start`), while it still works in that folder's project. A draft
 * moved to another project starts where that project's threads live.
 */
function useDraftFolder(input: {
  readonly draftKey: string | null;
  readonly start: FolderStart | null;
  readonly project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null;
}): FolderStart | null {
  const { draftKey, start } = input;
  useEffect(() => {
    if (draftKey !== null && start !== null) recordDraftFolder(draftKey, start);
  }, [draftKey, start]);
  const recorded = useAtomValue(draftFoldersAtom).get(input.draftKey ?? "");
  const project = input.project;
  return recorded !== undefined &&
    project?.environmentId === recorded.environmentId &&
    project.id === recorded.projectId
    ? recorded
    : null;
}
