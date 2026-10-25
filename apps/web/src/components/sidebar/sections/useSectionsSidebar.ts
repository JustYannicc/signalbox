import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import {
  isDesktopLocalConnectionTarget,
  isWslConnectionTarget,
} from "../../../connection/desktopLocal";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentSectionTreesAtom } from "../../../state/sections";
import type { EnvironmentPresentation } from "../../../state/environments";
import type { Project } from "../../../types";
import { useFoldersSidebar } from "../folders/useFoldersSidebar"; // signalbox: folders
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
  const folders = useFoldersSidebar(input); // signalbox: folders
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = (environmentId: EnvironmentId, sectionId: string) => {
    const sectionKey = sectionSidebarSectionKey(environmentId, sectionId);
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  };

  const sections = (() => {
    // signalbox: environments with folders show those instead (`sidebar/folders`).
    const servesFolders = (environmentId: EnvironmentId) =>
      serverConfigs.get(environmentId)?.environment.capabilities.folders === true;
    const projectEnvironmentIds = new Set(input.projects.map((project) => project.environmentId));
    const environmentIds = new Set<EnvironmentId>([
      ...projectEnvironmentIds,
      ...serverViews.keys(),
    ]);
    const environments: SectionSidebarEnvironment[] = input.environments.flatMap((environment) => {
      if (!environmentIds.has(environment.environmentId)) return [];
      if (servesFolders(environment.environmentId)) return [];
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
    const hasSavedSectionState =
      hasAnySavedSectionSidebarState(environments) ||
      // signalbox: with folders beside it, the rest keeps its tree rather than a flat list.
      input.environments.some((environment) => servesFolders(environment.environmentId));
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
      serverConfigs.get(environment.environmentId)?.environment.capabilities.sections === true &&
      !servesFolders(environment.environmentId) // signalbox: folders
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
  })();
  // signalbox: folders change with their threads, so they join outside the section trees' memo;
  // folder environments draw first, so their lists come first.
  return {
    ...sections,
    visibleProjectRows: [...folders.visibleRows, ...sections.visibleProjectRows],
    folders,
    // Only folders: the list is the user's folders, and adding brings in a source
    // (a repository gets a folder of its own). Projects stay projects anywhere else.
    labels:
      folders.environments.length > 0 && (sections.environments?.length ?? 0) === 0
        ? { title: "Folders", add: "Add a source" }
        : { title: "Projects", add: "Add project" },
  };
}
