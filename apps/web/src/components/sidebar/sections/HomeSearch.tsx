/**
 * Home search covers every Home item: real threads (title, PR, and message
 * matches, like the Pipeline), loose chats and tasks, team threads, rooms,
 * automations, places and accounts, and section and project agents. It reads
 * the tree's own index, so archived things stay out and every result names
 * the folder it lives in. Search is something you ask for, so it also finds
 * what Focus hides (like peeking). Results lead with their type icon.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { linkOptions, useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { SupervisorAvatar } from "../../assistant/AssistantGlyphs";
import { SourceMark } from "../../spaces/SpacesGlyphs";
import { mappingHealth } from "../../spaces/spacesMappings";
import { searchSidebarThreads } from "../../Sidebar.logic";
import { SidebarMenuButton, SidebarMenuItem } from "../../ui/sidebar";
import { homeThreadKey, type HomeProjectEntry } from "../useHomeSidebarData";
import type { MappedItem } from "./mappedItems";
import { useOpenHomeAgent } from "./openHomeAgent";
import { allHomeSections } from "./sectionModel";
import { ROOT_CONTAINER_KEY } from "./sectionStore";
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

function mappedIcon(item: MappedItem) {
  switch (item.kind) {
    case "automation":
      return <WorkflowIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />;
    case "account":
      return <SourceMark connector={item.source.connector} tone="sidebar" />;
    case "place":
      return <SourceMark connector={mappingHealth(item.mapping).connector} tone="sidebar" />;
    case "skill":
      return null;
  }
}

/** Where a strip item opens, from its home folder (same pages as its row). */
function mappedTarget(item: MappedItem, home: string) {
  switch (item.kind) {
    case "automation":
      return linkOptions({
        to: "/home/automations/$automationId",
        params: { automationId: item.automation.id },
      });
    case "account":
      return linkOptions({ to: "/spaces", search: { account: item.source.id, at: home } });
    case "place":
      return linkOptions({ to: "/spaces", search: { mapping: item.mapping.id, at: home } });
    case "skill":
      return linkOptions({ to: "/plugins", search: { section: "skills", skill: item.skill.id } });
  }
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
    // The folder's own name ("terminal-app"), or null at the top level.
    const labelByKey = new Map(
      tree.destinations.map((destination) => [
        destination.key,
        destination.label.split(" › ").at(-1) ?? destination.label,
      ]),
    );
    const folder = (key: string) =>
      key === ROOT_CONTAINER_KEY ? null : (labelByKey.get(key) ?? null);
    const agents = [
      ...allHomeSections().map((section) => ({ name: section.name, agentId: section.agentId })),
      ...collectProjectAgents(tree),
    ].filter((agent) => matches(`${agent.name} agent`, needle));

    const items: HomeSearchResult[] = [];
    const strip: HomeSearchResult[] = [];
    for (const [key, contents] of tree.index.byContainer) {
      for (const item of contents.loose) {
        if (!matches(item.title, needle)) continue;
        items.push({
          key: item.id,
          title: item.title,
          context: folder(key),
          icon: typeIcon(kindOf(item.id, item.type)),
          open: () => openShared(item.id),
        });
      }
      for (const thread of contents.teamThreads) {
        if (!matches(thread.title, needle)) continue;
        items.push({
          key: thread.id,
          title: thread.title,
          context: folder(key),
          icon: typeIcon(kindOf(thread.id, thread.kind)),
          open: () => openShared(thread.id),
        });
      }
      for (const room of contents.rooms) {
        if (!matches(room.title, needle)) continue;
        items.push({
          key: room.id,
          title: room.title,
          context: folder(key) ?? "Room",
          icon: typeIcon("room"),
          open: () => void navigate({ to: "/rooms/$roomId", params: { roomId: room.id } }),
        });
      }
      for (const item of contents.mapped) {
        // Once, from its home: references and skills' extra levels would repeat it.
        const home = tree.mapped.homeById.get(item.id) ?? null;
        if (item.kind === "skill" || home !== key || !matches(item.title, needle)) continue;
        strip.push({
          key: item.id,
          title: item.title,
          context: folder(home),
          icon: mappedIcon(item),
          open: () => void navigate(mappedTarget(item, home)),
        });
      }
    }

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
      ...items,
      ...strip,
      ...agents.map((agent) => ({
        key: `agent:${agent.agentId}`,
        title: `${agent.name} agent`,
        context: "Agent",
        icon: <SupervisorAvatar agentId={agent.agentId} size={16} />,
        open: () => openAgent(agent.agentId),
      })),
    ];
  }, [
    kindOverrides,
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
