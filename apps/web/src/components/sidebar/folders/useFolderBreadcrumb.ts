/**
 * Where a thread lives, as its header names it where the environment keeps
 * folders: the folder path ("Work / Signalbox"), or the level it sits at the top of.
 * The breadcrumb's action starts a new thread in that same place. Null where
 * the environment has no folders, so the header keeps naming the project.
 */
import { useAtomValue } from "@effect/atom-react";
import { contextOfProject } from "@t3tools/client-runtime/state/signalboxContexts";
import { homeOfThread, ownerFilesProject } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { environmentContextsAtom } from "../../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import { homeLabel } from "./folderSidebarModel";
import { useStartInFolder } from "./useStartInFolder";

export interface FolderBreadcrumb {
  readonly label: string;
  readonly onNewThread: () => void;
}

export function useFolderBreadcrumb(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}): FolderBreadcrumb | null {
  const snapshot = useAtomValue(environmentFoldersAtom).get(input.environmentId)?.snapshot ?? null;
  const contexts = useAtomValue(environmentContextsAtom).get(input.environmentId) ?? null;
  const startInFolder = useStartInFolder();
  const place = (() => {
    if (snapshot === null || contexts === null || input.projectId === null) return null;
    const projectId = input.projectId;
    const owner = contextOfProject(contexts, projectId);
    if (owner === undefined) return null;
    const home = homeOfThread(snapshot, { id: input.threadId, projectId });
    return {
      home,
      ownerProjectId: ownerFilesProject(owner),
      label: homeLabel(snapshot, owner, home),
    };
  })();
  const onNewThread = () => {
    if (place === null) return;
    void startInFolder({
      environmentId: input.environmentId,
      ownerProjectId: place.ownerProjectId,
      folderId: place.home,
    });
  };
  return place === null ? null : { label: place.label, onNewThread };
}
