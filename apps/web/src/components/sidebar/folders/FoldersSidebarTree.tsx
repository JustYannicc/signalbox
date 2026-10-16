/**
 * The Home sidebar of an environment with folders (Signalbox Cloud). Per
 * owner, Personal first: the threads living at its top level, then its
 * folders, nested at any depth. An open folder shows its subfolders, its
 * files as one "Files" source, and the threads that live there, drawn by
 * the sidebar's own project renderer inside a `SidebarThreadScope`.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadFolderChoices,
  threadHomeLookup,
  type FolderNode,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { useParams } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  SquarePenIcon,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useMemo, type KeyboardEvent } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { cn } from "../../../lib/utils";
import {
  folderEditableEnvironmentsAtom,
  retryEnvironmentFolders,
} from "../../../state/signalboxFolders";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../../../threadRoutes";
import { DriveShareDialogHost } from "../../drives/DriveProjectShareMenuItem";
import { NewSharedDriveButton } from "../../drives/NewSharedDriveButton";
import { Button } from "../../ui/button";
import { CollapsibleSectionHeader } from "../../ui/collapsible-section-header";
import { SidebarMenu, SidebarMenuItem, useSidebar } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { RenderProject } from "../sections/SectionsProjectTree";
import {
  FolderStatusCount,
  FolderStatusTooltip,
  useFolderStatus,
} from "../../statusLine/FolderStatusCount";
import { openFolderDialog } from "./folderDialogStore";
import { FolderMenu, OwnerMenu } from "./FolderMenus";
import {
  folderNodeKey,
  folderOwnerKey,
  folderThreadListKey,
  moveThreadMenuItem,
  movedThreadDestination,
  type FolderOwner,
} from "./folderSidebarModel";
import { folderThreadSliceAtom } from "./folderThreads";
import { SidebarThreadScopeContext, type SidebarThreadScope } from "./threadScope";
import { useFolderCommands, type FolderCommands } from "./useFolderCommands";
import {
  folderListRow,
  type FolderEnvironmentView,
  type FoldersSidebar,
} from "./useFoldersSidebar";
import { useStartInFolder, type StartInFolder } from "./useStartInFolder";

/** Nesting stops indenting past this depth, so deep trees keep their names readable. */
const MAX_INDENTED_DEPTH = 4;
const NO_SIBLINGS: ReadonlyArray<ProjectId> = [];

/** What every row reads; it changes when a folder folds, not when threads do. */
interface TreeContext {
  readonly collapsed: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
  readonly commands: FolderCommands;
  readonly start: (input: StartInFolder) => void;
}

const FolderTreeContext = createContext<TreeContext | null>(null);
/** Only the thread lists read the renderer and the open thread, so those redraw them alone. */
const RenderProjectContext = createContext<RenderProject | null>(null);
const ActiveThreadContext = createContext<string | null>(null);

function useTree(): TreeContext {
  const tree = useContext(FolderTreeContext);
  if (tree === null) throw new Error("Folder rows must render inside FoldersSidebarTree.");
  return tree;
}

/** The open thread, wherever it lives. */
function useActiveThreadKey(): string | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const ref = resolveActiveThreadRouteRef(routeTarget, draft);
  return ref ? scopedThreadKey(ref) : null;
}

interface ListProps {
  readonly environment: FolderEnvironmentView;
  readonly owner: FolderOwner;
  readonly home: FolderId | null;
  readonly canEdit: boolean;
}

/** The threads living at one home, as the sidebar's own thread list. */
function HomeThreads(props: ListProps) {
  const { environment, owner, home, canEdit } = props;
  const { environmentId, snapshot, projectKeys } = environment;
  const ownerId = owner.context.id;
  const { commands } = useTree();
  const activeThreadKey = useContext(ActiveThreadContext);
  const renderProject = useContext(RenderProjectContext);
  const listKey = folderThreadListKey(environmentId, ownerId, home);
  const threads = useAtomValue(folderThreadSliceAtom(listKey));
  // Only the list holding the open thread changes when it does.
  const activeHere = threads.some(
    (thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
  )
    ? activeThreadKey
    : null;
  const scope = useMemo<SidebarThreadScope>(() => {
    const homeOf = threadHomeLookup(snapshot);
    return {
      threads,
      activeThreadKey: activeHere,
      settingsProjectKey: (thread) => projectKeys.get(thread.projectId),
      threadMenu: (thread) => ({
        items: [
          moveThreadMenuItem(threadFolderChoices(snapshot, ownerId, homeOf(thread)), !canEdit),
        ],
        select: (clicked) => {
          const destination = movedThreadDestination(clicked);
          if (destination === null) return false;
          void commands.moveThread(environmentId, thread.id, destination.folderId);
          return true;
        },
      }),
    };
  }, [activeHere, canEdit, commands, environmentId, ownerId, projectKeys, snapshot, threads]);
  const project = environment.ownerProjects.get(ownerId);
  const row = useMemo(() => project && folderListRow(project, listKey), [listKey, project]);
  if (!row || !renderProject || threads.length === 0) return null;
  return (
    <SidebarThreadScopeContext value={scope}>
      {renderProject(environmentId, row, null, NO_SIBLINGS, null)}
    </SidebarThreadScopeContext>
  );
}

function FilesRow(props: { name: string; onOpen: () => void }) {
  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          delay={600}
          render={
            <button
              type="button"
              onClick={props.onOpen}
              className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md ps-5.5 pe-2 text-left text-xs text-sidebar-muted-foreground/75 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
            />
          }
        >
          <HardDriveIcon className="size-3.5 shrink-0 text-icon-muted" />
          <span className="truncate">Files</span>
        </TooltipTrigger>
        <TooltipPopup side="right">Browse {props.name}'s files</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const FolderRow = memo(function FolderRow(props: {
  environment: FolderEnvironmentView;
  owner: FolderOwner;
  node: FolderNode;
  depth: number;
  canEdit: boolean;
  counts: ReadonlyMap<FolderId, number>;
}) {
  const { environment, owner, node, depth, canEdit, counts } = props;
  const { collapsed, toggle, commands, start } = useTree();
  const { folder } = node;
  const key = folderNodeKey(environment.environmentId, folder.id);
  const expanded = !collapsed.has(key);
  const count = counts.get(folder.id) ?? 0;
  const status = useFolderStatus(key); // signalbox: status roll-up (#670)
  const empty = node.children.length === 0 && folder.files === undefined && count === 0;
  // A folder with its own files can start threads even where its owner has none.
  const canStart = owner.filesProjectId !== null || folder.files !== undefined;
  const startHere = (openFiles: boolean) =>
    start({
      environmentId: environment.environmentId,
      ownerProjectId: owner.filesProjectId,
      folderId: folder.id,
      openFiles,
    });
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded)) {
      event.preventDefault();
      toggle(key);
    }
  };

  return (
    <SidebarMenuItem>
      <div className="group/folder-row flex h-8 items-center gap-0.5 rounded-md pe-1 hover:bg-sidebar-row-hover has-data-popup-open:bg-sidebar-row-hover">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => toggle(key)}
          onKeyDown={handleKeyDown}
          className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md ps-1 text-left outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground/60 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          {expanded ? (
            <FolderOpenIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
          ) : (
            <FolderClosedIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
          )}
          <FolderStatusTooltip status={status}>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-muted-foreground/85">
              {folder.name}
            </span>
          </FolderStatusTooltip>
          <FolderStatusCount
            count={count}
            status={status}
            className="shrink-0 pe-1 text-3xs tabular-nums text-sidebar-muted-foreground/50 group-hover/folder-row:hidden group-focus-within/folder-row:hidden group-has-data-popup-open/folder-row:hidden pointer-coarse:hidden"
          />
        </button>
        <span className="hidden shrink-0 items-center group-hover/folder-row:flex group-focus-within/folder-row:flex group-has-data-popup-open/folder-row:flex pointer-coarse:flex">
          {canStart ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`New thread in ${folder.name}`}
                    onClick={() => startHere(false)}
                  />
                }
              >
                <SquarePenIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">New thread</TooltipPopup>
            </Tooltip>
          ) : null}
          {canEdit ? (
            <FolderMenu
              environmentId={environment.environmentId}
              snapshot={environment.snapshot}
              owner={owner}
              folder={folder}
              commands={commands}
            />
          ) : null}
        </span>
      </div>
      {expanded ? (
        <ul className={cn("flex flex-col gap-1", depth < MAX_INDENTED_DEPTH && "ps-3")}>
          {node.children.map((child) => (
            <FolderRow
              key={child.folder.id}
              environment={environment}
              owner={owner}
              node={child}
              depth={depth + 1}
              canEdit={canEdit}
              counts={counts}
            />
          ))}
          {folder.files ? <FilesRow name={folder.name} onOpen={() => startHere(true)} /> : null}
          <HomeThreads environment={environment} owner={owner} home={folder.id} canEdit={canEdit} />
          {empty ? (
            <li className="flex h-7 items-center ps-5.5 text-xs text-sidebar-muted-foreground/50">
              Empty
            </li>
          ) : null}
        </ul>
      ) : null}
    </SidebarMenuItem>
  );
});

function NewFolderRow(props: { environmentId: EnvironmentId; owner: FolderOwner }) {
  return (
    <SidebarMenuItem>
      <button
        type="button"
        onClick={() =>
          openFolderDialog({
            kind: "create",
            environmentId: props.environmentId,
            ownerId: props.owner.context.id,
            ownerName: props.owner.context.name,
            parent: null,
          })
        }
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md ps-5.5 pe-2 text-left text-xs text-sidebar-muted-foreground/60 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
      >
        <FolderPlusIcon aria-hidden className="size-3.5 shrink-0" />
        New folder
      </button>
    </SidebarMenuItem>
  );
}

const OwnerGroup = memo(function OwnerGroup(props: {
  environment: FolderEnvironmentView;
  owner: FolderOwner;
  snapshot: SignalboxFoldersSnapshot;
  canEdit: boolean;
  counts: ReadonlyMap<FolderId, number>;
}) {
  const { environment, owner, canEdit, counts } = props;
  const { collapsed, toggle, start } = useTree();
  const key = folderOwnerKey(environment.environmentId, owner.context.id);
  const expanded = !collapsed.has(key);
  const newThread =
    owner.filesProjectId === null
      ? null
      : () =>
          start({
            environmentId: environment.environmentId,
            ownerProjectId: owner.filesProjectId,
            folderId: null,
          });

  return (
    <section aria-label={owner.context.name} className="flex flex-col">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleSectionHeader expanded={expanded} onClick={() => toggle(key)}>
            {owner.context.name}
          </CollapsibleSectionHeader>
        </div>
        {owner.context.kind === "organization" ? (
          <NewSharedDriveButton
            environmentId={environment.environmentId}
            contextId={owner.context.id}
            contextName={owner.context.name}
          />
        ) : null}
        <OwnerMenu
          environmentId={environment.environmentId}
          snapshot={props.snapshot}
          owner={owner}
          canEdit={canEdit}
          onNewThread={newThread}
        />
      </div>
      {expanded ? (
        <SidebarMenu>
          <HomeThreads environment={environment} owner={owner} home={null} canEdit={canEdit} />
          {owner.roots.map((node) => (
            <FolderRow
              key={node.folder.id}
              environment={environment}
              owner={owner}
              node={node}
              depth={0}
              canEdit={canEdit}
              counts={counts}
            />
          ))}
          {canEdit ? (
            <NewFolderRow environmentId={environment.environmentId} owner={owner} />
          ) : null}
        </SidebarMenu>
      ) : null}
    </section>
  );
});

function FolderFailure(props: { environmentId: EnvironmentId; label: string; error: string }) {
  const retry = useAtomSet(retryEnvironmentFolders);
  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-2 pt-2 text-xs text-sidebar-muted-foreground"
    >
      Folders could not load for {props.label}: {props.error}
      <Button size="xs" variant="ghost-muted" onClick={() => retry(props.environmentId)}>
        Retry
      </Button>
    </div>
  );
}

const NO_COUNTS: ReadonlyMap<FolderId, number> = new Map();

export function FoldersSidebarTree(props: {
  sidebar: FoldersSidebar;
  renderProject: RenderProject;
}) {
  const { sidebar } = props;
  const commands = useFolderCommands();
  const startInFolder = useStartInFolder();
  const editable = useAtomValue(folderEditableEnvironmentsAtom);
  const activeThreadKey = useActiveThreadKey();
  const { isMobile, setOpenMobile } = useSidebar();
  const start = useCallback(
    (input: StartInFolder) => {
      if (isMobile) setOpenMobile(false);
      void startInFolder(input);
    },
    [isMobile, setOpenMobile, startInFolder],
  );
  const tree = useMemo<TreeContext>(
    () => ({ collapsed: sidebar.collapsed, toggle: sidebar.toggle, commands, start }),
    [commands, sidebar.collapsed, sidebar.toggle, start],
  );
  if (sidebar.environments.length === 0 && sidebar.failures.length === 0) return null;

  return (
    <FolderTreeContext value={tree}>
      <RenderProjectContext value={props.renderProject}>
        <ActiveThreadContext value={activeThreadKey}>
          <div className="flex flex-col gap-2">
            {sidebar.environments.map((environment) => (
              <section
                key={environment.environmentId}
                // One environment is nothing to announce: no region, like no heading.
                aria-label={sidebar.showEnvironmentLabels ? environment.label : undefined}
                className="flex flex-col gap-1"
              >
                {sidebar.showEnvironmentLabels ? (
                  <h3 className="px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
                    {environment.label}
                  </h3>
                ) : null}
                <DriveShareDialogHost environmentId={environment.environmentId} />
                {environment.owners.map((owner) => (
                  <OwnerGroup
                    key={owner.context.id}
                    environment={environment}
                    owner={owner}
                    snapshot={environment.snapshot}
                    canEdit={editable.has(environment.environmentId)}
                    counts={sidebar.counts.get(environment.environmentId) ?? NO_COUNTS}
                  />
                ))}
              </section>
            ))}
            {sidebar.failures.map((failure) => (
              <FolderFailure key={failure.environmentId} {...failure} />
            ))}
          </div>
        </ActiveThreadContext>
      </RenderProjectContext>
    </FolderTreeContext>
  );
}
