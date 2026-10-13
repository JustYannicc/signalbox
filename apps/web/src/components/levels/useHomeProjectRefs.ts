/**
 * Real projects as the Home tree keys them (logical project groups), for
 * resolving fixture home targets (`resolveTarget`) outside the sidebar. The
 * keys match `LevelOption.key` (`project:<projectKey>`).
 */
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { ProjectRef } from "../sidebar/sections/mappedItems";

export function useHomeProjectRefs(): readonly ProjectRef[] {
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects,
        settings: groupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }).map(({ projectKey, displayName, workspaceRoot }) => ({
        projectKey,
        displayName,
        workspaceRoot,
      })),
    [groupingSettings, primaryEnvironmentId, projects],
  );
}
