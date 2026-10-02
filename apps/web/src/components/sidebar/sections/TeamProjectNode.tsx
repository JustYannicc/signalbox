/**
 * A placeholder team project (e.g. merchant-portal): your agent for it, its
 * threads and rooms, and while folded how many of them need you.
 */
import { homeThreadKey } from "../useHomeSidebarData";
import { renderHomeThreadRow, type HomeThreadRowContext } from "../HomeThreadRow";
import { isContentsEmpty } from "./containerContents";
import { ContainerItems } from "./HomeItems";
import { HomeTreeNode } from "./HomeTreeNode";
import { NodeAddButton, NodeMoreMenu } from "./NodeMenus";
import { archiveInHome, useHomeSectionStore } from "./sectionStore";
import type { HomeTeamProjectView } from "./useHomeSectionTree";

export function TeamProjectNode(props: {
  view: HomeTeamProjectView;
  sectionId: string;
  rowContext: HomeThreadRowContext;
  projectNameByThreadKey: ReadonlyMap<string, string>;
}) {
  const { project, contents } = props.view;
  const nodeKey = `team-project:${project.id}`;
  const name = useHomeSectionStore((state) => state.names[nodeKey]) ?? project.name;
  const place = { containerKey: nodeKey, containerId: project.id, sharedContainer: true };

  return (
    <HomeTreeNode
      nodeKey={nodeKey}
      label={name}
      agentId={props.view.agentId}
      agentName={`${name} agent`}
      agentStatus={null}
      inTeam
      rollup={props.view.rollup}
      movable={{ kind: "project", key: nodeKey, label: name }}
      destination={{ key: nodeKey, label: name, kind: "project" }}
      actions={
        <>
          <NodeAddButton token={{ id: nodeKey, kind: "project", label: name }} />
          <NodeMoreMenu
            nodeKey={nodeKey}
            name={name}
            movable={{ kind: "project", key: nodeKey, label: name }}
            currentKey={`section:${props.sectionId}`}
            share={{ kind: "project", name, teamId: project.teamId }}
            containerId={project.id}
            onArchive={() => archiveInHome(nodeKey, name, "Project", { sharedWithOthers: true })}
          />
        </>
      }
    >
      {isContentsEmpty(contents) ? (
        <li className="flex h-8 items-center px-2.5 text-xs text-sidebar-muted-foreground/50">
          Empty
        </li>
      ) : (
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
      )}
    </HomeTreeNode>
  );
}
