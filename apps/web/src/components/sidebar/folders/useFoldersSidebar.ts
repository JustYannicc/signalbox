import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { useState } from "react";

import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import type { ProjectGroupingSettings } from "../../../logicalProject";
import type { EnvironmentPresentation } from "../../../state/environments";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import type { Project, SidebarThreadSummary } from "../../../types";
import type {
  SectionSidebarProject,
  SectionSidebarVisibleProjectRow,
} from "../sections/sectionProjectTree";
import { visibleFolderLists, type FolderOwner } from "./folderSidebarModel";
import {
  folderCountsAtom,
  folderThreadSlicesAtom,
  folderTreesAtom,
  type FolderEnvironmentTree,
} from "./folderThreads";

export interface FolderEnvironmentView extends FolderEnvironmentTree {
  readonly label: string;
  /** The project row each owner's lists draw with (`ownerListProject`). */
  readonly ownerProjects: ReadonlyMap<SignalboxContextId, SidebarProjectSnapshot>;
  /** Each project's own key, for its settings. */
  readonly projectKeys: ReadonlyMap<ProjectId, string>;
}

const SEPARATE: ProjectGroupingSettings = {
  sidebarProjectGroupingMode: "separate",
  sidebarProjectGroupingOverrides: {},
};

/**
 * The project row an owner's thread lists draw with: its own files' row,
 * spanning all of its projects, so a thread's path is its own project's.
 * Built from the owner's projects one by one, never grouped.
 */
function ownerProjects(input: {
  environment: EnvironmentPresentation;
  owners: ReadonlyArray<FolderOwner>;
  projects: ReadonlyArray<Project>;
  primaryEnvironmentId: EnvironmentId | null;
}) {
  const snapshots = buildSidebarProjectSnapshots({
    projects: input.projects,
    settings: SEPARATE,
    primaryEnvironmentId: input.primaryEnvironmentId,
    resolveEnvironmentLabel: () => input.environment.label,
  });
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const lists = new Map<SignalboxContextId, SidebarProjectSnapshot>();
  for (const owner of input.owners) {
    const members = owner.context.projectIds.flatMap((id) => byId.get(id) ?? []);
    const own = (owner.filesProjectId && byId.get(owner.filesProjectId)) || members[0];
    if (own === undefined) continue;
    lists.set(owner.context.id, {
      ...own,
      memberProjects: members.flatMap((member) => member.memberProjects),
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
    });
  }
  return {
    lists,
    keys: new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.projectKey])),
  };
}

/** The row a list hands the sidebar's project renderer: keyed by the list. */
export function folderListRow(
  project: SidebarProjectSnapshot,
  listKey: string,
): SectionSidebarProject {
  return { id: project.id, sidebarProjectKey: listKey, project, sectionId: null };
}

/**
 * The Home sidebar's folder environments, their collapse state, the lists
 * it shows (for jump keys and ↑/↓), and the environments whose folders
 * failed to load.
 */
export function useFoldersSidebar(input: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  projects: ReadonlyArray<Project>;
  primaryEnvironmentId: EnvironmentId | null;
}) {
  const folders = useAtomValue(environmentFoldersAtom);
  const trees = useAtomValue(folderTreesAtom);
  const counts = useAtomValue(folderCountsAtom);
  const slices = useAtomValue(folderThreadSlicesAtom);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const environments: ReadonlyArray<FolderEnvironmentView> = input.environments.flatMap(
    (environment) => {
      const tree = trees.get(environment.environmentId);
      if (tree === undefined) return [];
      const { lists, keys } = ownerProjects({
        environment,
        owners: tree.owners,
        projects: input.projects.filter(
          (project) => project.environmentId === environment.environmentId,
        ),
        primaryEnvironmentId: input.primaryEnvironmentId,
      });
      return [{ ...tree, label: environment.label, ownerProjects: lists, projectKeys: keys }];
    },
  );

  const failures = input.environments.flatMap((environment) => {
    const error = folders.get(environment.environmentId)?.error;
    return error
      ? [{ environmentId: environment.environmentId, label: environment.label, error }]
      : [];
  });

  const visibleRows: ReadonlyArray<SectionSidebarVisibleProjectRow> = visibleFolderLists(
    environments,
    collapsed,
  ).flatMap((list) => {
    const project = environments
      .find((environment) => environment.environmentId === list.environmentId)
      ?.ownerProjects.get(list.owner.context.id);
    const threads: ReadonlyArray<SidebarThreadSummary> | undefined = slices.get(list.listKey);
    return project && threads
      ? [
          {
            environmentId: list.environmentId,
            project: folderListRow(project, list.listKey),
            threads,
          },
        ]
      : [];
  });

  return {
    environments,
    counts,
    failures,
    visibleRows,
    showEnvironmentLabels: input.environments.length > 1,
    collapsed,
    toggle,
  };
}

export type FoldersSidebar = ReturnType<typeof useFoldersSidebar>;
