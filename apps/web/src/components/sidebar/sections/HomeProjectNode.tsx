/**
 * A real project inside a Home section: a foldable node over its recent
 * threads plus anything moved in. Drag it onto a section, or "⋯ › Move to…".
 * Archive hides it from your sidebar only.
 */
import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { memo } from "react";

import { renderHomeThreadRow, type HomeThreadRowContext } from "../HomeThreadRow";
import { homeThreadKey } from "../useHomeSidebarData";
import { isContentsEmpty } from "./containerContents";
import { ContainerItems } from "./HomeItems";
import { HomeTreeNode } from "./HomeTreeNode";
import { NodeAddButton, NodeMoreMenu } from "./NodeMenus";
import { archiveInHome, useHomeSectionStore } from "./sectionStore";
import { PROJECT_THREAD_PREVIEW_COUNT, type HomeProjectView } from "./useHomeSectionTree";

export const HomeProjectNode = memo(function HomeProjectNode(props: {
  view: HomeProjectView;
  sectionId: string;
  /** Set when the project sits in a team section. */
  team: { readonly id: string; readonly name: string } | null;
  rowContext: HomeThreadRowContext;
  onNewThread: (projectRef: ScopedProjectRef) => void;
}) {
  const { view } = props;
  const { group } = view.entry;
  const { threads } = view;
  const nodeKey = `project:${group.projectKey}`;
  const name = useHomeSectionStore((state) => state.names[nodeKey]) ?? group.displayName;
  const showAll = useHomeSectionStore((state) => group.projectKey in state.showAllKeys);
  const place = {
    containerKey: nodeKey,
    containerId: props.sectionId,
    sharedContainer: props.team !== null,
  };
  // The open thread always stays reachable, even when it sits past the preview cut.
  const activeIndex = threads.findIndex(
    (thread) => homeThreadKey(thread) === props.rowContext.activeThreadKey,
  );
  const visibleCount =
    showAll || activeIndex >= PROJECT_THREAD_PREVIEW_COUNT
      ? threads.length
      : PROJECT_THREAD_PREVIEW_COUNT;

  return (
    <HomeTreeNode
      nodeKey={nodeKey}
      label={name}
      agentId={view.agentId}
      agentName={`${name} agent`}
      agentStatus={null}
      inTeam={props.team !== null}
      rollup={view.rollup}
      movable={{ kind: "project", key: group.projectKey, label: name }}
      destination={{ key: nodeKey, label: name, kind: "project" }}
      actions={
        <>
          <NodeAddButton
            token={{
              id: `project:${group.environmentId}:${group.id}`,
              kind: "project",
              label: name,
              projectRef: scopeProjectRef(group.environmentId, group.id),
            }}
          />
          <NodeMoreMenu
            nodeKey={nodeKey}
            name={name}
            movable={{ kind: "project", key: group.projectKey, label: name }}
            currentKey={`section:${props.sectionId}`}
            share={props.team ? { kind: "project", name, teamId: props.team.id } : null}
            containerId={props.sectionId}
            onArchive={() =>
              archiveInHome(nodeKey, name, "Project", { sharedWithOthers: props.team !== null })
            }
          />
        </>
      }
    >
      {threads.length === 0 && isContentsEmpty(view.contents) ? (
        <li className="flex h-8 items-center px-2.5 text-xs text-sidebar-muted-foreground/50">
          Empty
        </li>
      ) : (
        threads
          .slice(0, visibleCount)
          .map((thread) => renderHomeThreadRow(thread, name, props.rowContext, place))
      )}
      {threads.length > PROJECT_THREAD_PREVIEW_COUNT &&
      activeIndex < PROJECT_THREAD_PREVIEW_COUNT ? (
        <li>
          <button
            type="button"
            onClick={() => useHomeSectionStore.getState().setShowAll(group.projectKey, !showAll)}
            className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            {showAll ? "Show less" : `Show ${threads.length - PROJECT_THREAD_PREVIEW_COUNT} more`}
          </button>
        </li>
      ) : null}
      <ContainerItems
        contents={view.contents}
        place={place}
        renderThread={(thread) => renderHomeThreadRow(thread, name, props.rowContext, place)}
      />
    </HomeTreeNode>
  );
});
