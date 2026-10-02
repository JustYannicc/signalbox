/**
 * How many things need you right now, across everything Home knows about:
 * real threads (Pipeline statuses), fixture chats and tasks, team threads and
 * @mentions, rooms waiting on you, your section agents, and automation runs.
 * Respects Focus (hidden sections don't count). One selector so the rail bell,
 * Home, and anything else agree.
 */
import { useMemo } from "react";

import { automationAttention } from "../../automations/automationStatus";
import { TEAM_PROJECTS } from "../../multiplayer/multiplayerFixtures";
import { useRoomArchiveStore } from "../../rooms/rooms";
import { THREAD_STATUS_DISPLAY } from "../../threadStatusDisplay";
import { useProjects, useThreadShells } from "../../../state/entities";
import { useUiStateStore } from "../../../uiStateStore";
import { isInFocus, useFocusStore } from "../focus/focusStore";
import { homeThreadKey } from "../useHomeSidebarData";
import { buildContainerIndex, roomNeedsYou } from "./containerContents";
import { containerIdForKey, containerIdForThread, HOME_TOP_LEVEL_ID } from "./containerIds";
import { statusForThread } from "./homeStatus";
import { signalsForTeamThread } from "./itemSignals";
import { allHomeSections, allLooseItems, findHomeSection } from "./sectionModel";
import { useHomeSectionStore } from "./sectionStore";

/** Container id → the section Focus judges it by (`null` = top level). */
function sectionOfContainer(containerId: string): string | null {
  if (containerId === HOME_TOP_LEVEL_ID) return null;
  if (findHomeSection(containerId)) return containerId;
  return TEAM_PROJECTS.find((project) => project.id === containerId)?.sectionId ?? null;
}

export function useNeedsYouCount(): number {
  const threads = useThreadShells();
  const projects = useProjects();
  const lastVisited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const archived = useHomeSectionStore((state) => state.archived);
  // Cached by `allLooseItems`, so this only changes when loose items do.
  const looseItems = useHomeSectionStore(() => allLooseItems());
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const archivedRooms = useRoomArchiveStore((state) => state.archived);
  const mode = useFocusStore((state) => state.mode);

  return useMemo(() => {
    const placement = { itemContainers, projectSectionOverrides };
    const inFocus = (containerId: string) =>
      isInFocus({ sectionId: sectionOfContainer(containerId) }, mode);
    const projectById = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
    );
    let count = 0;

    for (const thread of threads) {
      // Settled reads as archived; the server un-settles it if it needs you.
      if (thread.archivedAt !== null || thread.settledOverride === "settled") continue;
      const key = homeThreadKey(thread);
      const status = statusForThread(thread, lastVisited[key]);
      if (!status || !THREAD_STATUS_DISPLAY[status].needsYou) continue;
      const project = projectById.get(`${thread.environmentId}:${thread.projectId}`);
      // Approximation: grouped-project moves aren't known here, so the name heuristic decides.
      const containerId = containerIdForThread(
        {
          threadKey: key,
          project: project
            ? {
                projectKey: `${project.environmentId}:${project.id}`,
                displayName: project.title,
                workspaceRoot: project.workspaceRoot,
              }
            : null,
        },
        placement,
      );
      if (inFocus(containerId)) count += 1;
    }

    const index = buildContainerIndex({
      projectEntries: [],
      looseItems,
      archived,
      archivedRooms,
      itemContainers,
    });
    for (const [containerKey, contents] of index.byContainer) {
      if (!inFocus(containerIdForKey(containerKey, placement))) continue;
      for (const item of contents.loose) {
        if (item.status && THREAD_STATUS_DISPLAY[item.status].needsYou) count += 1;
      }
      for (const thread of contents.teamThreads) {
        const signals = signalsForTeamThread(thread.id);
        const statusNeedsYou =
          signals.status !== undefined && THREAD_STATUS_DISPLAY[signals.status].needsYou;
        if (statusNeedsYou || signals.mentionedById) count += 1;
      }
      count += contents.rooms.filter(roomNeedsYou).length;
    }

    for (const section of allHomeSections()) {
      if (`section:${section.id}` in archived || !inFocus(section.id)) continue;
      if (section.agentStatus && THREAD_STATUS_DISPLAY[section.agentStatus].needsYou) count += 1;
    }

    return count + automationAttention().length;
  }, [
    archived,
    archivedRooms,
    itemContainers,
    lastVisited,
    looseItems,
    mode,
    projectSectionOverrides,
    projects,
    threads,
  ]);
}
