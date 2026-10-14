/**
 * The Home sidebar of an environment with folders (Signalbox Cloud). Per
 * owner, Personal first: the threads living at its top level, then its
 * folders, nested at any depth. An open folder shows its subfolders, its
 * files as one "Files" source, and the threads that live there. Thread rows
 * are the sidebar's own (`renderThreads`).
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { FolderNode } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import {
  ChevronRightIcon,
  FolderClosedIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HardDriveIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../../lib/utils";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { retryEnvironmentFolders, signalboxFolders } from "../../../state/signalboxFolders";
import { DriveShareDialogHost } from "../../drives/DriveProjectShareMenuItem";
import { NewSharedDriveButton } from "../../drives/NewSharedDriveButton";
import { Button } from "../../ui/button";
import { CollapsibleSectionHeader } from "../../ui/collapsible-section-header";
import { SidebarMenu, SidebarMenuItem, useSidebar } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { openFolderDialog } from "./folderDialogStore";
import { FolderMenu, OwnerMenu } from "./FolderMenus";
import {
  folderNodeKey,
  folderOwnerKey,
  folderThreadListKey,
  moveThreadMenuItem,
  movedThreadDestination,
} from "./folderSidebarModel";
import type { SidebarThreadScope } from "./threadScope";
import { useFolderCommands, type FolderCommands } from "./useFolderCommands";
import type { FolderEnvironmentView, FolderOwnerView, FoldersSidebar } from "./useFoldersSidebar";
import { useStartInFolder, type StartInFolder } from "./useStartInFolder";

/** Nesting stops indenting past this depth, so deep trees keep their names readable. */
const MAX_INDENTED_DEPTH = 4;

export interface FolderThreadList {
  readonly key: string;
  /** The project the list belongs to: its owner's own files. */
  readonly project: SidebarProjectSnapshot;
  readonly scope: SidebarThreadScope;
}

interface TreeContext {
  readonly collapsed: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
  readonly commands: FolderCommands;
  readonly start: (input: StartInFolder) => void;
  readonly renderThreads: (list: FolderThreadList) => ReactNode;
}

const FolderTreeContext = createContext<TreeContext | null>(null);

function useTree(): TreeContext {
  const tree = useContext(FolderTreeContext);
  if (tree === null) throw new Error("Folder rows must render inside FoldersSidebarTree.");
  return tree;
}

/** The threads living at one home, as the sidebar's own thread list. */
function HomeThreads(props: {
  environment: FolderEnvironmentView;
  owner: FolderOwnerView;
  home: FolderId | null;
  canEdit: boolean;
}) {
  const { environment, owner, home, canEdit } = props;
  const { commands, renderThreads } = useTree();
  const { environmentId, snapshot, homeOf, projectRows } = environment;
  const ownerId = owner.context.id;
  const projectIds = owner.context.projectIds;
  // Only what changes with the tree: a new scope would redraw every thread row.
  const scope = useMemo<SidebarThreadScope>(
    () => ({
      listKey: folderThreadListKey(environmentId, ownerId, home),
      projectRefs: projectIds.map((projectId) => scopeProjectRef(environmentId, projectId)),
      includes: (thread) => homeOf(thread) === home,
      projectOf: (thread) => projectRows.get(thread.projectId)?.project,
      threadMenu: (thread) => ({
        items: [{ ...moveThreadMenuItem(snapshot, ownerId, homeOf(thread)), disabled: !canEdit }],
        select: (clicked) => {
          const destination = movedThreadDestination(clicked);
          if (destination === null) return false;
          void commands.moveThread(environmentId, thread.id, destination.folderId);
          return true;
        },
      }),
    }),
    [canEdit, commands, environmentId, home, homeOf, ownerId, projectIds, projectRows, snapshot],
  );
  const row =
    (owner.filesProjectId && projectRows.get(owner.filesProjectId)) ||
    projectIds.map((id) => projectRows.get(id)).find(Boolean);
  if (!row || (owner.threadsByHome.get(home)?.length ?? 0) === 0) return null;
  return renderThreads({ key: scope.listKey, project: row.project, scope });
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

function FolderRow(props: {
  environment: FolderEnvironmentView;
  owner: FolderOwnerView;
  node: FolderNode;
  depth: number;
  canEdit: boolean;
}) {
  const { environment, owner, node, depth, canEdit } = props;
  const { collapsed, toggle, commands, start } = useTree();
  const { folder } = node;
  const key = folderNodeKey(environment.environmentId, folder.id);
  const expanded = !collapsed.has(key);
  const count = owner.counts.get(folder.id) ?? 0;
  const ownThreads = owner.threadsByHome.get(folder.id)?.length ?? 0;
  const empty = node.children.length === 0 && folder.files === undefined && ownThreads === 0;
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
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-muted-foreground/85">
            {folder.name}
          </span>
          {count > 0 ? (
            <span className="shrink-0 pe-1 text-3xs tabular-nums text-sidebar-muted-foreground/50 group-hover/folder-row:hidden group-focus-within/folder-row:hidden group-has-data-popup-open/folder-row:hidden pointer-coarse:hidden">
              {count}
              <span className="sr-only"> {count === 1 ? "thread" : "threads"}</span>
            </span>
          ) : null}
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
}

function OwnerGroup(props: { environment: FolderEnvironmentView; owner: FolderOwnerView }) {
  const { environment, owner } = props;
  const { collapsed, toggle, start } = useTree();
  const canEdit = useAtomValue(
    signalboxFolders.updateFolder.permissionAtom(environment.environmentId),
  );
  const key = folderOwnerKey(environment.environmentId, owner.context.id);
  const expanded = !collapsed.has(key);
  const filesProjectId = owner.filesProjectId;
  const newThread = filesProjectId
    ? () =>
        start({
          environmentId: environment.environmentId,
          ownerProjectId: filesProjectId,
          folderId: null,
        })
    : null;

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
          snapshot={environment.snapshot}
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
            />
          ))}
          {canEdit ? (
            <SidebarMenuItem>
              <button
                type="button"
                onClick={() =>
                  openFolderDialog({
                    kind: "create",
                    environmentId: environment.environmentId,
                    ownerId: owner.context.id,
                    ownerName: owner.context.name,
                    parent: null,
                  })
                }
                className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md ps-5.5 pe-2 text-left text-xs text-sidebar-muted-foreground/60 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
              >
                <FolderPlusIcon aria-hidden className="size-3.5 shrink-0" />
                New folder
              </button>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
      ) : null}
    </section>
  );
}

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

export function FoldersSidebarTree(props: {
  sidebar: FoldersSidebar;
  renderThreads: (list: FolderThreadList) => ReactNode;
}) {
  const { sidebar } = props;
  const commands = useFolderCommands();
  const startInFolder = useStartInFolder();
  const { isMobile, setOpenMobile } = useSidebar();
  const start = useCallback(
    (input: StartInFolder) => {
      if (isMobile) setOpenMobile(false);
      void startInFolder(input);
    },
    [isMobile, setOpenMobile, startInFolder],
  );
  const tree = useMemo<TreeContext>(
    () => ({
      collapsed: sidebar.collapsed,
      toggle: sidebar.toggle,
      commands,
      start,
      renderThreads: props.renderThreads,
    }),
    [commands, props.renderThreads, sidebar.collapsed, sidebar.toggle, start],
  );
  if (sidebar.environments.length === 0 && sidebar.failures.length === 0) return null;

  return (
    <FolderTreeContext value={tree}>
      <div className="flex flex-col gap-2">
        {sidebar.environments.map((environment) => (
          <section
            key={environment.environmentId}
            aria-label={environment.label}
            className="flex flex-col gap-1"
          >
            {sidebar.showEnvironmentLabels ? (
              <h3 className="px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground/70">
                {environment.label}
              </h3>
            ) : null}
            <DriveShareDialogHost environmentId={environment.environmentId} />
            {environment.owners.map((owner) => (
              <OwnerGroup key={owner.context.id} environment={environment} owner={owner} />
            ))}
          </section>
        ))}
        {sidebar.failures.map((failure) => (
          <FolderFailure key={failure.environmentId} {...failure} />
        ))}
      </div>
    </FolderTreeContext>
  );
}
