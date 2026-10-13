/**
 * How many things need you right now, across everything Home knows about:
 * real threads (Pipeline statuses), fixture chats and tasks, team threads and
 * @mentions, rooms waiting on you, your section agents, and automation runs.
 * Respects Focus: whatever sits out of sight doesn't count (every item goes
 * through `isInSight`, where escalation rules will land). One selector so the
 * rail bell, Home, and anything else agree.
 */
import { useMemo } from "react";

import { useAutomations } from "../../homeAutomations/runDecisions";
import { TOP_LEVEL } from "../../levels/levels";
import { TEAM_PROJECTS } from "../../multiplayer/multiplayerFixtures";
import { useRoomArchiveStore } from "../../rooms/rooms";
import { THREAD_STATUS_DISPLAY, type ThreadDisplayStatus } from "../../threadStatusDisplay";
import { useProjects } from "../../../state/entities";
import { useUiStateStore } from "../../../uiStateStore";
import { isInSight } from "../focus/focusLevels";
import { useFocusedLevel } from "../focus/focusStore";
import { automationAttentionInFocus } from "../focus/needsYouInFocus";
import { homeThreadKey, useHomeThreadShells } from "../useHomeSidebarData";
import { buildContainerIndex, roomNeedsYou } from "./containerContents";
import { containerIdForKey, containerIdForThread, HOME_TOP_LEVEL_ID } from "./containerIds";
import { statusForThread } from "./homeStatus";
import { EMPTY_MAPPED_INDEX, useMappedStore } from "./mappedItems";
import { signalsForTeamThread } from "./itemSignals";
import { allHomeSections, allLooseItems, findHomeSection } from "./sectionModel";
import { useHomeSectionStore } from "./sectionStore";

/** Container id → the level Focus judges it by. */
function levelOfContainer(containerId: string): string {
  if (containerId === HOME_TOP_LEVEL_ID) return TOP_LEVEL;
  if (findHomeSection(containerId)) return `section:${containerId}`;
  return TEAM_PROJECTS.some((project) => project.id === containerId)
    ? `team-project:${containerId}`
    : TOP_LEVEL;
}

export function useNeedsYouCount(): number {
  const threads = useHomeThreadShells();
  const projects = useProjects();
  const lastVisited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const archived = useHomeSectionStore((state) => state.archived);
  // Cached by `allLooseItems`, so this only changes when loose items do.
  const looseItems = useHomeSectionStore(() => allLooseItems());
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const projectSectionOverrides = useHomeSectionStore((state) => state.projectSectionOverrides);
  const archivedRooms = useRoomArchiveStore((state) => state.archived);
  const focused = useFocusedLevel();
  const automations = useAutomations();
  const mappedHomes = useMappedStore((state) => state.homes);
  const mappedReferences = useMappedStore((state) => state.references);
  const mappedReach = useMappedStore((state) => state.reach);

  return useMemo(() => {
    const placement = { itemContainers, projectSectionOverrides };
    const inFocus = (containerId: string, status: ThreadDisplayStatus | null = null) =>
      isInSight({ levels: [levelOfContainer(containerId)], status }, focused, placement);
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
      if (inFocus(containerId, status)) count += 1;
    }

    const index = buildContainerIndex({
      projectEntries: [],
      looseItems,
      archived,
      archivedRooms,
      itemContainers,
      // Automations count once below, by run, wherever they're mapped.
      mapped: EMPTY_MAPPED_INDEX,
    });
    for (const [containerKey, contents] of index.byContainer) {
      const containerId = containerIdForKey(containerKey, placement);
      // Per item, so an escalation rule can let one through a hidden folder.
      for (const item of contents.loose) {
        const status = item.status ?? null;
        if (status && THREAD_STATUS_DISPLAY[status].needsYou && inFocus(containerId, status)) {
          count += 1;
        }
      }
      for (const thread of contents.teamThreads) {
        const signals = signalsForTeamThread(thread.id);
        const status = signals.status ?? null;
        const statusNeedsYou = status !== null && THREAD_STATUS_DISPLAY[status].needsYou;
        if ((statusNeedsYou || signals.mentionedById) && inFocus(containerId, status)) count += 1;
      }
      if (inFocus(containerId, "input")) count += contents.rooms.filter(roomNeedsYou).length;
    }

    for (const section of allHomeSections()) {
      if (`section:${section.id}` in archived) continue;
      if (!isInSight({ levels: [`section:${section.id}`] }, focused, placement)) continue;
      if (section.agentStatus && THREAD_STATUS_DISPLAY[section.agentStatus].needsYou) count += 1;
    }

    const automationRuns = automationAttentionInFocus({
      automations,
      projects: [...projectById].map(([projectKey, project]) => ({
        projectKey,
        displayName: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
      overrides: { homes: mappedHomes, references: mappedReferences, reach: mappedReach },
      projectSectionOverrides,
      focused,
    });
    return count + automationRuns.length;
  }, [
    archived,
    archivedRooms,
    automations,
    focused,
    itemContainers,
    lastVisited,
    looseItems,
    mappedHomes,
    mappedReach,
    mappedReferences,
    projectSectionOverrides,
    projects,
    threads,
  ]);
}
