/**
 * The Home view's list: the Focus chip, "Chats" (everything unfiled, newest
 * first, capped with "Show N more", like Codex's chat list), then
 * sections › projects › tasks, chats, and rooms, a quiet "New section", and
 * everything archived (from Home or the Pipeline). Rows navigate, archive,
 * move, and flip Chat/Task; the rest of thread management (Later, reorder,
 * pin) stays in the Pipeline.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { FolderPlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { FocusPausedChip } from "./focus/FocusPausedChip";
import { HomeDrafts } from "./HomeDrafts";
import { useFocusStore } from "./focus/focusStore";
import { renderHomeThreadRow, type HomeThreadRowContext } from "./HomeThreadRow";
import { ArchivedList } from "./sections/ArchivedList";
import { isContentsEmpty } from "./sections/containerContents";
import { HOME_TOP_LEVEL_ID } from "./sections/containerIds";
import { ContainerItems } from "./sections/HomeItems";
import { HomeDestinationsContext, useHomeDropTarget } from "./sections/homeMoves";
import { HomeSectionNode } from "./sections/HomeSectionNode";
import { ROOT_CONTAINER_KEY, useHomeSectionStore } from "./sections/sectionStore";
import type { HomeSectionTree } from "./sections/useHomeSectionTree";
import { homeThreadKey } from "./useHomeSidebarData";

export type { HomeThreadRowContext } from "./HomeThreadRow";

export function HomeSectionLabel(props: { children: ReactNode }) {
  return (
    <h3 className="px-2.5 pt-4 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
      {props.children}
    </h3>
  );
}

const togglePeek = () => useFocusStore.getState().togglePeek();
/** Unfiled chats shown before "Show N more", like Codex's chat list. */
const CHATS_PREVIEW_COUNT = 8;
const TOP_LEVEL_PLACE = {
  containerKey: ROOT_CONTAINER_KEY,
  containerId: HOME_TOP_LEVEL_ID,
  sharedContainer: false,
};

export function HomeSidebarTree(props: {
  tree: HomeSectionTree;
  hasProjects: boolean;
  archivedThreads: readonly EnvironmentThreadShell[];
  projectNameByThreadKey: ReadonlyMap<string, string>;
  rowContext: HomeThreadRowContext;
  onNewThread: (projectRef: ScopedProjectRef) => void;
  onAddProject: () => void;
}) {
  const { tree } = props;
  // The whole list takes drops to the top level; nodes stop the event for their own drops.
  const { dropActive, dropProps } = useHomeDropTarget({
    key: ROOT_CONTAINER_KEY,
    label: "Top level",
    kind: "root",
  });

  return (
    <HomeDestinationsContext value={tree.destinations}>
      <div
        {...dropProps}
        className={cn("flex flex-col rounded-md px-2 pb-2", dropActive && "ring-1 ring-ring")}
      >
        {tree.paused ? (
          <FocusPausedChip
            hiddenLabel={tree.paused.hiddenLabel}
            runningCount={tree.paused.runningCount}
            peeking={tree.peeking}
            onTogglePeek={togglePeek}
          />
        ) : null}
        <HomeDrafts label={<HomeSectionLabel>Drafts</HomeSectionLabel>} />
        {isContentsEmpty(tree.rootContents) ? null : (
          <section aria-label="Chats" className="pt-2">
            <h3 className="px-2.5 pb-0.5 text-2xs font-medium text-sidebar-muted-foreground/60">
              Chats
            </h3>
            <ul className="flex flex-col gap-px">
              <ContainerItems
                contents={tree.rootContents}
                place={TOP_LEVEL_PLACE}
                limit={CHATS_PREVIEW_COUNT}
                activeThreadKey={props.rowContext.activeThreadKey}
                renderThread={(thread) =>
                  renderHomeThreadRow(
                    thread,
                    props.projectNameByThreadKey.get(homeThreadKey(thread)) ?? null,
                    props.rowContext,
                    TOP_LEVEL_PLACE,
                  )
                }
              />
            </ul>
          </section>
        )}
        <ul className="flex flex-col gap-px pt-2">
          {tree.roots.map((node) => (
            <HomeSectionNode
              key={node.section.id}
              node={node}
              rowContext={props.rowContext}
              projectNameByThreadKey={props.projectNameByThreadKey}
              onNewThread={props.onNewThread}
            />
          ))}
        </ul>
        {props.hasProjects ? null : (
          <button
            type="button"
            onClick={props.onAddProject}
            className="flex h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            Add a project
          </button>
        )}
        <button
          type="button"
          onClick={() => useHomeSectionStore.getState().createSection(null)}
          className="mt-1 flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs text-sidebar-muted-foreground/60 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <FolderPlusIcon className="size-3.5" />
          New section
        </button>
        <ArchivedList archivedThreads={props.archivedThreads} />
      </div>
    </HomeDestinationsContext>
  );
}
