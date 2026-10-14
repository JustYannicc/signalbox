import { useAtomValue } from "@effect/atom-react";
import { threadHomeLookup } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { useCallback, useMemo, useState } from "react";

import {
  isDesktopLocalConnectionTarget,
  isWslConnectionTarget,
} from "../../../connection/desktopLocal";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../../state/environments";
import { environmentContextsAtom } from "../../../state/signalboxContexts";
import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import type { Project, SidebarThreadSummary } from "../../../types";
import {
  buildSectionSidebarEnvironment,
  type SectionSidebarProject,
} from "../sections/sectionProjectTree";
import {
  folderOwners,
  folderThreadCounts,
  threadsByHome,
  type FolderOwnerThreads,
  type HomeOf,
} from "./folderSidebarModel";

export interface FolderOwnerView extends FolderOwnerThreads<SidebarThreadSummary> {
  /** Threads living in each folder or below it. */
  readonly counts: ReadonlyMap<FolderId, number>;
}

export interface FolderEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly homeOf: HomeOf;
  /** Each project as the thread list draws it, one row per project of this environment. */
  readonly projectRows: ReadonlyMap<ProjectId, SectionSidebarProject>;
  /** Personal first, then each organization, in the contexts' order. */
  readonly owners: ReadonlyArray<FolderOwnerView>;
}

/**
 * The Home sidebar's folder environments, their collapse state, and those
 * that failed to load. The tree itself only changes with folders, contexts
 * and projects; threads only regroup it.
 */
export function useFoldersSidebar(input: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  projects: ReadonlyArray<Project>;
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  primaryEnvironmentId: EnvironmentId | null;
  threads: ReadonlyArray<SidebarThreadSummary>;
}) {
  const folders = useAtomValue(environmentFoldersAtom);
  const contexts = useAtomValue(environmentContextsAtom);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const structure = useMemo(() => {
    const trees = [];
    const failures: Array<{ environmentId: EnvironmentId; label: string; error: string }> = [];
    for (const environment of input.environments) {
      const { environmentId } = environment;
      const environmentFolders = folders.get(environmentId);
      if (environmentFolders === undefined) continue;
      if (environmentFolders.error !== null) {
        failures.push({ environmentId, label: environment.label, error: environmentFolders.error });
      }
      const snapshot = environmentFolders.snapshot;
      const environmentContexts = contexts.get(environmentId);
      if (snapshot === null || environmentContexts === undefined) continue;
      const rows = buildSectionSidebarEnvironment({
        environmentId,
        label: environment.label,
        primaryEnvironmentId: input.primaryEnvironmentId,
        isDesktopLocalEnvironment: isDesktopLocalConnectionTarget(environment.entry.target),
        isWslEnvironment: isWslConnectionTarget(environment.entry.target),
        projects: input.projects.filter((project) => project.environmentId === environmentId),
        projectGroups: input.projectGroups,
        serverView: undefined,
      }).tree.unplacedProjects;
      trees.push({
        environmentId,
        label: environment.label,
        snapshot,
        homeOf: threadHomeLookup(snapshot),
        projectRows: new Map(rows.map((row) => [row.id, row])),
        owners: folderOwners(environmentContexts, snapshot),
      });
    }
    return { trees, failures };
  }, [
    contexts,
    folders,
    input.environments,
    input.primaryEnvironmentId,
    input.projectGroups,
    input.projects,
  ]);

  const environments = useMemo(
    (): ReadonlyArray<FolderEnvironmentView> =>
      structure.trees.map((tree) => {
        const threads = input.threads.filter(
          (thread) => thread.environmentId === tree.environmentId,
        );
        return {
          ...tree,
          owners: tree.owners.map((owner) => {
            const byHome = threadsByHome(tree.homeOf, owner, threads);
            return {
              ...owner,
              threadsByHome: byHome,
              counts: folderThreadCounts(owner.roots, byHome),
            };
          }),
        };
      }),
    [input.threads, structure],
  );

  return useMemo(
    () => ({
      environments,
      failures: structure.failures,
      showEnvironmentLabels: input.environments.length > 1,
      collapsed,
      toggle,
    }),
    [collapsed, environments, input.environments.length, structure.failures, toggle],
  );
}

export type FoldersSidebar = ReturnType<typeof useFoldersSidebar>;
