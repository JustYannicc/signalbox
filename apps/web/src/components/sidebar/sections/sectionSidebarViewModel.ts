import type {
  SidebarThreadPreviewCount,
  SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";

import { sortThreads } from "../../../lib/threadSort";
import { projectExpansionPreferenceKeys } from "../../../sidebarProjectExpansion";
import { resolveProjectExpanded } from "../../../uiStateStore";
import type { SidebarThreadSummary } from "../../../types";
import type { SectionSidebarVisibleProjectRow } from "./sectionProjectTree";

export function visibleSectionThreadKeys(input: {
  rows: ReadonlyArray<SectionSidebarVisibleProjectRow>;
  threads: ReadonlyArray<SidebarThreadSummary>;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  expandedThreadLists: ReadonlySet<string>;
  projectExpandedById: Readonly<Record<string, boolean>>;
  activeThreadKey: string | null;
}): string[] {
  const threadsByProject = new Map<string, SidebarThreadSummary[]>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const key = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const current = threadsByProject.get(key);
    if (current) current.push(thread);
    else threadsByProject.set(key, [thread]);
  }

  return input.rows.flatMap(({ environmentId, project }) => {
    const projectKey = scopedProjectKey(scopeProjectRef(environmentId, project.id));
    const projectThreads = sortThreads(
      threadsByProject.get(projectKey) ?? [],
      input.threadSortOrder,
    );
    const projectExpanded = resolveProjectExpanded(
      input.projectExpandedById,
      projectExpansionPreferenceKeys(project.project, project.sidebarProjectKey),
    );
    const pinnedCollapsedThread =
      !projectExpanded && input.activeThreadKey
        ? (projectThreads.find(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
              input.activeThreadKey,
          ) ?? null)
        : null;
    if (!projectExpanded && pinnedCollapsedThread === null) return [];

    const hasOverflowingThreads = projectThreads.length > input.threadPreviewCount;
    const previewThreads =
      input.expandedThreadLists.has(project.sidebarProjectKey) || !hasOverflowingThreads
        ? projectThreads
        : projectThreads.slice(0, input.threadPreviewCount);
    const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreads;
    return renderedThreads.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
  });
}
