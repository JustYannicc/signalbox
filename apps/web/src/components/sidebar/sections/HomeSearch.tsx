/**
 * Home search covers every Home item: real threads (title, PR, and message
 * matches, like the Pipeline), loose chats and tasks, team threads, rooms, and
 * section and project agents. Results lead with their type icon.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

import { SupervisorAvatar } from "../../assistant/AssistantGlyphs";
import { TEAM_THREADS } from "../../multiplayer/multiplayerFixtures";
import { ALL_ROOMS } from "../../rooms/rooms";
import { searchSidebarThreads } from "../../Sidebar.logic";
import { SidebarMenuButton, SidebarMenuItem } from "../../ui/sidebar";
import { homeThreadKey, type HomeProjectEntry } from "../useHomeSidebarData";
import { useOpenHomeAgent } from "./openHomeAgent";
import { allHomeSections, allLooseItems } from "./sectionModel";
import { useHomeSectionStore } from "./sectionStore";
import { classifyThread, useThreadKindStore } from "./threadKind";
import { ITEM_TYPE_ICON, type HomeItemType } from "./ThreadKindIcon";
import type { HomeSectionTree } from "./useHomeSectionTree";
import { useOpenSharedThread } from "./useOpenSharedThread";

export interface HomeSearchResult {
  readonly key: string;
  readonly title: string;
  readonly context: string | null;
  readonly icon: ReactNode;
  readonly open: () => void;
}

function typeIcon(type: HomeItemType) {
  const Icon = ITEM_TYPE_ICON[type];
  return <Icon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
}

const matches = (text: string, query: string) => text.toLowerCase().includes(query);

export function useHomeSearch(input: {
  query: string;
  projectEntries: readonly HomeProjectEntry[];
  projectNameByThreadKey: ReadonlyMap<string, string>;
  serverMatchKeys: ReadonlySet<string>;
  tree: HomeSectionTree;
  openThread: (thread: EnvironmentThreadShell) => void;
}): readonly HomeSearchResult[] {
  const { query, projectEntries, projectNameByThreadKey, serverMatchKeys, tree, openThread } =
    input;
  const kindOverrides = useThreadKindStore((state) => state.overrides);
  const looseItems = useHomeSectionStore(() => allLooseItems());
  const { open: openShared } = useOpenSharedThread();
  const openAgent = useOpenHomeAgent();
  const navigate = useNavigate();

  return useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const threads = searchSidebarThreads(
      projectEntries.flatMap((entry) => entry.threads),
      query,
      serverMatchKeys,
    );
    const kindOf = (key: string, fallback: "chat" | "task") => kindOverrides[key] ?? fallback;
    const agents = [
      ...allHomeSections().map((section) => ({ name: section.name, agentId: section.agentId })),
      ...collectProjectAgents(tree),
    ].filter((agent) => matches(`${agent.name} agent`, needle));

    return [
      ...threads.map((thread): HomeSearchResult => {
        const key = homeThreadKey(thread);
        const classified = classifyThread({
          title: thread.title,
          hasWorkspace: thread.branch != null || thread.worktreePath != null,
        }).kind;
        return {
          key,
          title: thread.title,
          context: projectNameByThreadKey.get(key) ?? null,
          icon: typeIcon(kindOf(key, classified)),
          open: () => openThread(thread),
        };
      }),
      ...looseItems
        .filter((item) => matches(item.title, needle))
        .map((item) => ({
          key: item.id,
          title: item.title,
          context: null,
          icon: typeIcon(kindOf(item.id, item.type)),
          open: () => openShared(item.id),
        })),
      ...TEAM_THREADS.filter((thread) => matches(thread.title, needle)).map((thread) => ({
        key: thread.id,
        title: thread.title,
        context: thread.projectId,
        icon: typeIcon(kindOf(thread.id, thread.kind)),
        open: () => openShared(thread.id),
      })),
      ...ALL_ROOMS.filter((room) => matches(room.title, needle)).map((room) => ({
        key: room.id,
        title: room.title,
        context: "Room",
        icon: typeIcon("room"),
        open: () => void navigate({ to: "/rooms/$roomId", params: { roomId: room.id } }),
      })),
      ...agents.map((agent) => ({
        key: `agent:${agent.agentId}`,
        title: `${agent.name} agent`,
        context: "Your agent",
        icon: <SupervisorAvatar agentId={agent.agentId} size={16} />,
        open: () => openAgent(agent.agentId),
      })),
    ];
  }, [
    kindOverrides,
    looseItems,
    navigate,
    openAgent,
    openShared,
    openThread,
    projectEntries,
    projectNameByThreadKey,
    query,
    serverMatchKeys,
    tree,
  ]);
}

function collectProjectAgents(tree: HomeSectionTree) {
  const agents: { name: string; agentId: string }[] = [];
  const walk = (node: HomeSectionTree["roots"][number]) => {
    for (const project of node.projects) {
      agents.push({ name: project.entry.group.displayName, agentId: project.agentId });
    }
    for (const project of node.teamProjects) {
      agents.push({ name: project.project.name, agentId: project.agentId });
    }
    node.childSections.forEach(walk);
  };
  tree.roots.forEach(walk);
  return agents;
}

export function HomeSearchResults(props: {
  results: readonly HomeSearchResult[];
  pending: boolean;
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="flex flex-col px-2 pb-2">
      {props.results.length === 0 ? (
        <p className="px-2.5 pt-4 pb-1 text-xs text-sidebar-muted-foreground/70">
          {props.pending ? "Searching…" : "Nothing found"}
        </p>
      ) : null}
      <ul className="flex flex-col gap-px pt-2" role="listbox" aria-label="Search results">
        {props.results.map((result, index) => (
          <SidebarMenuItem key={result.key} role="presentation">
            <SidebarMenuButton
              role="option"
              aria-selected={index === props.highlightedIndex}
              isActive={index === props.highlightedIndex}
              onMouseEnter={() => props.onHighlight(index)}
              onClick={() => props.onSelect(index)}
            >
              {result.icon}
              <span className="min-w-0 flex-1 truncate">{result.title}</span>
              {result.context ? (
                <span className="max-w-[40%] shrink-0 truncate text-xs text-sidebar-muted-foreground/60">
                  {result.context}
                </span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </ul>
    </div>
  );
}
