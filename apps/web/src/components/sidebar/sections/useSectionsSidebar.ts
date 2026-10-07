import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import {
  isDesktopLocalConnectionTarget,
  isWslConnectionTarget,
} from "../../../connection/desktopLocal";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentSectionTreesAtom } from "../../../state/sections";
import type { EnvironmentPresentation } from "../../../state/environments";
import type { Project } from "../../../types";
import type { SectionEnvironmentOption } from "./SectionSidebarActions";
import {
  buildSectionSidebarEnvironment,
  hasAnySavedSectionSidebarState,
  sectionSidebarSectionKey,
  visibleSectionProjectRows,
  type SectionSidebarEnvironment,
} from "./sectionProjectTree";

export function useSectionsSidebar(input: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  projects: ReadonlyArray<Project>;
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  primaryEnvironmentId: EnvironmentId | null;
}) {
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const serverViews = useAtomValue(environmentSectionTreesAtom);
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = useCallback((environmentId: EnvironmentId, sectionId: string) => {
    const sectionKey = sectionSidebarSectionKey(environmentId, sectionId);
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  }, []);

  return useMemo(() => {
    const projectEnvironmentIds = new Set(input.projects.map((project) => project.environmentId));
    const environmentIds = new Set<EnvironmentId>([
      ...projectEnvironmentIds,
      ...serverViews.keys(),
    ]);
    const environments: SectionSidebarEnvironment[] = input.environments.flatMap((environment) => {
      if (!environmentIds.has(environment.environmentId)) return [];
      const projects = input.projects.filter(
        (project) => project.environmentId === environment.environmentId,
      );
      const serverView = serverViews.get(environment.environmentId);
      if (
        projects.length === 0 &&
        (serverView?.tree.roots.length ?? 0) === 0 &&
        (serverView?.snapshot?.sections.length ?? 0) === 0 &&
        (serverView?.snapshot?.projectPlacements.length ?? 0) === 0
      ) {
        return [];
      }
      return [
        buildSectionSidebarEnvironment({
          environmentId: environment.environmentId,
          label: environment.label,
          primaryEnvironmentId: input.primaryEnvironmentId,
          isDesktopLocalEnvironment: isDesktopLocalConnectionTarget(environment.entry.target),
          isWslEnvironment: isWslConnectionTarget(environment.entry.target),
          projects,
          projectGroups: input.projectGroups,
          serverView,
        }),
      ];
    });
    const hasSavedSectionState = hasAnySavedSectionSidebarState(environments);
    const visibleProjectRows = visibleSectionProjectRows(environments, collapsedSections);
    const failures = input.environments.flatMap((environment) => {
      const status = serverViews.get(environment.environmentId)?.status;
      return status?._tag === "Failure"
        ? [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              error: status.error,
            },
          ]
        : [];
    });
    const createOptions: SectionEnvironmentOption[] = input.environments.flatMap((environment) =>
      environment.connection.phase === "connected" &&
      serverConfigs.get(environment.environmentId)?.environment.capabilities.sections === true
        ? [{ environmentId: environment.environmentId, label: environment.label }]
        : [],
    );
    return {
      environments: hasSavedSectionState ? environments : null,
      createOptions,
      failures,
      showEnvironmentLabels: environments.length > 1,
      collapsedSections,
      toggleSection,
      visibleProjectRows,
    };
  }, [
    input.environments,
    input.primaryEnvironmentId,
    input.projectGroups,
    input.projects,
    collapsedSections,
    serverConfigs,
    serverViews,
    toggleSection,
  ]);
}
