import { useMemo } from "react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { useClientSettings } from "../../hooks/useSettings";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import {
  firstValidTimestampMs,
  orderItemsByPreferredIds,
  sortLogicalProjectsForSidebar,
} from "../Sidebar.logic";

export interface HomeProjectEntry {
  readonly group: SidebarProjectSnapshot;
  /** Live threads, most recent first. Home has no Pinned group; pins live in the Pipeline. */
  readonly threads: readonly EnvironmentThreadShell[];
}

export const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

export function homeThreadKey(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function threadRecencyMs(thread: EnvironmentThreadShell): number {
  return firstValidTimestampMs(thread.latestUserMessageAt, thread.updatedAt, thread.createdAt);
}

/**
 * The Home view's project tree: the same logical project groups and sort order
 * the Pipeline uses, with each group's live threads hung underneath it.
 */
export function useHomeSidebarData() {
  const projects = useProjects();
  const threads = useThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();

  // Rows resolve their harness per environment: default instance ids are driver
  // slugs, so one flat map would collide across environments (as in the Pipeline).
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );

  const projectGroups = useMemo(() => {
    const environmentLabelById = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    const orderedProjects =
      sortOrder === "manual"
        ? orderItemsByPreferredIds({
            items: projects,
            preferredIds: projectOrder,
            getId: getProjectOrderKey,
            getPreferenceIds: (project) => [
              getProjectOrderKey(project),
              legacyProjectCwdPreferenceKey(project.workspaceRoot),
            ],
          })
        : projects;
    const groups = buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: groupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    });
    return sortLogicalProjectsForSidebar(groups, threads, sortOrder);
  }, [
    environments,
    groupingSettings,
    primaryEnvironmentId,
    projectOrder,
    projects,
    sortOrder,
    threads,
  ]);

  const lists = useMemo(() => {
    // One Archive: the Pipeline's settle is shown as Archive, so settled
    // threads live in Home › Archived next to server-archived ones (same
    // capability gate as the Pipeline's Archived group).
    const isArchived = (thread: EnvironmentThreadShell) =>
      thread.archivedAt !== null ||
      (thread.settledOverride === "settled" &&
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true);
    const liveThreads = threads.filter((thread) => !isArchived(thread));
    // Threads archived from anywhere, for Home › Archived (restorable there).
    const archivedThreads = threads.filter(isArchived);

    const groupKeyByProjectKey = new Map<string, string>();
    for (const group of projectGroups) {
      for (const member of group.memberProjects) {
        groupKeyByProjectKey.set(`${member.environmentId}:${member.id}`, group.projectKey);
      }
    }
    const threadsByGroupKey = new Map<string, EnvironmentThreadShell[]>();
    const projectNameByThreadKey = new Map<string, string>();
    const projectKeyByThreadKey = new Map<string, string>();
    const groupByKey = new Map(projectGroups.map((group) => [group.projectKey, group] as const));
    for (const thread of liveThreads) {
      const groupKey = groupKeyByProjectKey.get(`${thread.environmentId}:${thread.projectId}`);
      if (groupKey === undefined) continue;
      const group = groupByKey.get(groupKey);
      projectKeyByThreadKey.set(homeThreadKey(thread), groupKey);
      if (group) projectNameByThreadKey.set(homeThreadKey(thread), group.displayName);
      const bucket = threadsByGroupKey.get(groupKey);
      if (bucket) bucket.push(thread);
      else threadsByGroupKey.set(groupKey, [thread]);
    }

    const projectEntries: HomeProjectEntry[] = projectGroups.map((group) => ({
      group,
      threads: (threadsByGroupKey.get(group.projectKey) ?? []).toSorted(
        (left, right) => threadRecencyMs(right) - threadRecencyMs(left),
      ),
    }));

    return {
      archivedThreads,
      projectEntries,
      projectKeyByThreadKey,
      projectNameByThreadKey,
    };
  }, [projectGroups, serverConfigs, threads]);

  return { ...lists, providerEntriesByEnvironment };
}
