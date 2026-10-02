/**
 * A Home section or team: child sections, projects, then its own tasks,
 * chats, and rooms. A team shows at most three people; clicking them opens
 * who has access. Takes drops of items, projects, and sections.
 */
import type { ScopedProjectRef } from "@t3tools/contracts";

import { findTeam } from "../../multiplayer/teamThreads";
import { renderHomeThreadRow, type HomeThreadRowContext } from "../HomeThreadRow";
import { homeThreadKey } from "../useHomeSidebarData";
import { isContentsEmpty } from "./containerContents";
import { ContainerItems } from "./HomeItems";
import { HomeProjectNode } from "./HomeProjectNode";
import { HomeTreeNode } from "./HomeTreeNode";
import { NodeAddButton, NodeMoreMenu, TeamCluster } from "./NodeMenus";
import { ROOT_CONTAINER_KEY, archiveInHome } from "./sectionStore";
import { TeamProjectNode } from "./TeamProjectNode";
import type { HomeSectionNode as HomeSectionTreeNode } from "./useHomeSectionTree";

export function HomeSectionNode(props: {
  node: HomeSectionTreeNode;
  rowContext: HomeThreadRowContext;
  projectNameByThreadKey: ReadonlyMap<string, string>;
  onNewThread: (projectRef: ScopedProjectRef) => void;
}) {
  const { section, childSections, projects, teamProjects, contents } = props.node;
  const team = section.kind === "team" && section.teamId ? findTeam(section.teamId) : undefined;
  const nodeKey = `section:${section.id}`;
  const place = {
    containerKey: nodeKey,
    containerId: section.id,
    sharedContainer: team !== undefined,
  };
  const isEmpty =
    childSections.length === 0 &&
    projects.length === 0 &&
    teamProjects.length === 0 &&
    isContentsEmpty(contents);

  return (
    <HomeTreeNode
      nodeKey={nodeKey}
      label={section.name}
      agentId={section.agentId}
      agentName={section.agentName}
      agentStatus={section.agentStatus}
      inTeam={team !== undefined}
      rollup={props.node.rollup}
      cluster={team ? <TeamCluster team={team} /> : null}
      dimmed={props.node.peeked}
      movable={{ kind: "section", id: section.id, label: section.name }}
      destination={{ key: nodeKey, label: section.name, kind: "section" }}
      actions={
        <>
          <NodeAddButton token={{ id: nodeKey, kind: "section", label: section.name }} />
          <NodeMoreMenu
            nodeKey={nodeKey}
            name={section.name}
            movable={{ kind: "section", id: section.id, label: section.name }}
            currentKey={section.parentId ? `section:${section.parentId}` : ROOT_CONTAINER_KEY}
            share={team ? { kind: "team", teamId: team.id } : null}
            containerId={section.id}
            sectionId={section.id}
            onArchive={() =>
              archiveInHome(nodeKey, section.name, "Section", {
                sharedWithOthers: team !== undefined,
              })
            }
          />
        </>
      }
    >
      {childSections.map((child) => (
        <HomeSectionNode
          key={child.section.id}
          node={child}
          rowContext={props.rowContext}
          projectNameByThreadKey={props.projectNameByThreadKey}
          onNewThread={props.onNewThread}
        />
      ))}
      {teamProjects.map((view) => (
        <TeamProjectNode
          key={view.project.id}
          view={view}
          sectionId={section.id}
          rowContext={props.rowContext}
          projectNameByThreadKey={props.projectNameByThreadKey}
        />
      ))}
      {projects.map((view) => (
        <HomeProjectNode
          key={view.entry.group.projectKey}
          view={view}
          sectionId={section.id}
          team={team ? { id: team.id, name: team.name } : null}
          rowContext={props.rowContext}
          onNewThread={props.onNewThread}
        />
      ))}
      <ContainerItems
        contents={contents}
        place={place}
        renderThread={(thread) =>
          renderHomeThreadRow(
            thread,
            props.projectNameByThreadKey.get(homeThreadKey(thread)) ?? null,
            props.rowContext,
            place,
          )
        }
      />
      {isEmpty ? (
        <li className="flex h-8 items-center px-2.5 text-xs text-sidebar-muted-foreground/50">
          Empty
        </li>
      ) : null}
    </HomeTreeNode>
  );
}
