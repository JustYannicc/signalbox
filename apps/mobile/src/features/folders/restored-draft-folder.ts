import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ComposerDraftProject } from "../../state/use-composer-drafts";
import type { FolderStart } from "./folder-filter";

/** Restores the saved folder only while its stamped project remains selected. */
export function restoredDraftFolderStart(
  stamp: ComposerDraftProject | undefined,
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null,
): FolderStart | null {
  const saved = stamp?.folderStart;
  if (
    !stamp ||
    !saved ||
    !project ||
    project.environmentId !== stamp.environmentId ||
    project.id !== stamp.projectId
  ) {
    return null;
  }
  return {
    environmentId: stamp.environmentId,
    projectId: stamp.projectId,
    folderId: saved.folderId,
    name: saved.name,
    file: saved.file,
    unfiledName: saved.unfiledName,
  };
}

