import { useAtomValue } from "@effect/atom-react";
import { contextOfProject } from "@t3tools/client-runtime/state/signalboxContexts";
import { homeOfProject } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { environmentContextsAtom } from "../../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import { homeLabel } from "./folderSidebarModel";

/**
 * Where a project's things live, as headers name it ("Dev / signalbox"), e.g.
 * an automation's breadcrumb or its palette entry. Null where the environment
 * has no folders, or no owner holds the project.
 */
export function useProjectHomeLabels(): (
  environmentId: EnvironmentId,
  projectId: ProjectId,
) => string | null {
  const folders = useAtomValue(environmentFoldersAtom);
  const contexts = useAtomValue(environmentContextsAtom);
  return useCallback(
    (environmentId, projectId) => {
      const snapshot = folders.get(environmentId)?.snapshot ?? null;
      const owner = contextOfProject(contexts.get(environmentId) ?? null, projectId);
      return snapshot === null || owner === undefined
        ? null
        : homeLabel(snapshot, owner, homeOfProject(snapshot, projectId));
    },
    [contexts, folders],
  );
}

export function useProjectHomeLabel(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): string | null {
  const labelOf = useProjectHomeLabels();
  return projectId === null ? null : labelOf(environmentId, projectId);
}
