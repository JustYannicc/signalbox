/**
 * The Home sidebar of an environment with folders (Signalbox Cloud), drawn
 * as the level tree (#225). The list itself is your top level: the threads
 * living there, then your folders, nested at any depth, then each
 * organization you're a member of as a level row holding its own threads and
 * folders. An open folder shows its subfolders, its files as one "Files"
 * source, and the threads that live there, drawn by the sidebar's own
 * project renderer inside a `SidebarThreadScope`.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  inOwnerLevel,
  ownerLevels,
  threadFolderChoices,
  threadHomeLookup,
  type FolderNode,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { useParams } from "@tanstack/react-router";
import {
  Building2Icon,
  FolderClosedIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HardDriveIcon,
} from "lucide-react";
import { createContext, memo, useContext, type ReactNode } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import {
  folderEditableEnvironmentsAtom,
  retryEnvironmentFolders,
} from "../../../state/signalboxFolders";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../../../threadRoutes";
import { DriveShareDialogHost } from "../../drives/DriveProjectShareMenuItem";
import { NewSharedDriveButton } from "../../drives/NewSharedDriveButton";
import { Button } from "../../ui/button";
import { SidebarMenu, SidebarMenuItem, useSidebar } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { RenderProject } from "../sections/SectionsProjectTree";
import {
  FolderStatusCount,
  FolderStatusTooltip,
  useFolderStatus,
} from "../../statusLine/FolderStatusCount";
import { openFolderDialog } from "./folderDialogStore";
import { LevelRow, NewThreadButton } from "./LevelRow";
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
  const scope = ((): SidebarThreadScope => {
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
  })();
  const project = environment.ownerProjects.get(ownerId);
  const row = project && folderListRow(project, listKey);
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

  return (
    <LevelRow
      expanded={expanded}
      onToggle={() => toggle(key)}
      icon={
        expanded ? (
          <FolderOpenIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
        ) : (
          <FolderClosedIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
        )
      }
      name={
        <FolderStatusTooltip status={status}>
          <span>{folder.name}</span>
        </FolderStatusTooltip>
      }
      trailing={
        count > 0 || status?.summary ? <FolderStatusCount count={count} status={status} /> : null
      }
      actions={
        <>
          {canStart ? (
            <NewThreadButton name={folder.name} onClick={() => startHere(false)} />
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
        </>
      }
      indentChildren={depth < MAX_INDENTED_DEPTH}
    >
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
    </LevelRow>
  );
});

function NewFolderRow(props: { environmentId: EnvironmentId; owner: FolderOwner }) {
  return (
    <SidebarMenuItem>
      <button
        type="button"
        aria-label={`New folder ${inOwnerLevel(props.owner.context)}`}
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

interface LevelProps {
  environment: FolderEnvironmentView;
  owner: FolderOwner;
  canEdit: boolean;
  counts: ReadonlyMap<FolderId, number>;
}

/** What a level holds: the threads living at its top, its folders, then `after`. */
function LevelContents(props: LevelProps & { depth: number; after?: ReactNode }) {
  const { environment, owner, canEdit, counts } = props;
  return (
    <>
      <HomeThreads environment={environment} owner={owner} home={null} canEdit={canEdit} />
      {owner.roots.map((node) => (
        <FolderRow
          key={node.folder.id}
          environment={environment}
          owner={owner}
          node={node}
          depth={props.depth}
          canEdit={canEdit}
          counts={counts}
        />
      ))}
      {props.after}
      {canEdit ? <NewFolderRow environmentId={environment.environmentId} owner={owner} /> : null}
    </>
  );
}

/** An organization you're a member of: a level of its own, folded like a folder. */
const MemberLevel = memo(function MemberLevel(props: LevelProps & { depth: number }) {
  const { environment, owner } = props;
  const { collapsed, toggle, start } = useTree();
  const key = folderOwnerKey(environment.environmentId, owner.context.id);
  const expanded = !collapsed.has(key);
  const filesProjectId = owner.filesProjectId;

  return (
    <LevelRow
      expanded={expanded}
      onToggle={() => toggle(key)}
      icon={<Building2Icon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />}
      name={owner.context.name}
      actions={
        <>
          {filesProjectId === null ? null : (
            <NewThreadButton
              name={owner.context.name}
              onClick={() =>
                start({
                  environmentId: environment.environmentId,
                  ownerProjectId: filesProjectId,
                  folderId: null,
                })
              }
            />
          )}
          <NewSharedDriveButton
            environmentId={environment.environmentId}
            contextId={owner.context.id}
            contextName={owner.context.name}
          />
        </>
      }
      indentChildren={props.depth < MAX_INDENTED_DEPTH}
    >
      <LevelContents {...props} depth={props.depth + 1} />
    </LevelRow>
  );
});

/** One environment's tree: your top level, with every member level inside it. */
function EnvironmentLevels(props: {
  environment: FolderEnvironmentView;
  canEdit: boolean;
  counts: ReadonlyMap<FolderId, number>;
}) {
  const { environment, canEdit, counts } = props;
  const { top, members } = ownerLevels(environment.owners, (owner) => owner.context);
  const memberLevels = members.map((owner) => (
    <MemberLevel
      key={owner.context.id}
      environment={environment}
      owner={owner}
      canEdit={canEdit}
      counts={counts}
      depth={0}
    />
  ));
  return (
    <SidebarMenu>
      {top ? (
        <LevelContents
          environment={environment}
          owner={top}
          canEdit={canEdit}
          counts={counts}
          depth={0}
          after={memberLevels}
        />
      ) : (
        memberLevels
      )}
    </SidebarMenu>
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

const NO_COUNTS: ReadonlyMap<FolderId, number> = new Map();

/** Starts a thread in a folder, closing the sidebar first where it covers the page. */
function useStartFromSidebar(): (input: StartInFolder) => void {
  const startInFolder = useStartInFolder();
  const { isMobile, setOpenMobile } = useSidebar();
  return (input: StartInFolder) => {
    if (isMobile) setOpenMobile(false);
    void startInFolder(input);
  };
}

/** Your top level's ⋯ (new thread, instructions, secrets): it has no row of its own. */
function TopLevelMenu(props: { environment: FolderEnvironmentView }) {
  const { environment } = props;
  const editable = useAtomValue(folderEditableEnvironmentsAtom);
  const start = useStartFromSidebar();
  const { top } = ownerLevels(environment.owners, (owner) => owner.context);
  if (top === null) return null;
  const filesProjectId = top.filesProjectId;
  return (
    <OwnerMenu
      environmentId={environment.environmentId}
      snapshot={environment.snapshot}
      owner={top}
      canEdit={editable.has(environment.environmentId)}
      onNewThread={
        filesProjectId === null
          ? null
          : () =>
              start({
                environmentId: environment.environmentId,
                ownerProjectId: filesProjectId,
                folderId: null,
              })
      }
    />
  );
}

/**
 * The top level's ⋯ for the Home list's header row. With several
 * environments each one's label carries its own instead.
 */
export function FoldersTopLevelMenu(props: { sidebar: FoldersSidebar }) {
  const { environments, showEnvironmentLabels } = props.sidebar;
  const only = environments.length === 1 && !showEnvironmentLabels ? environments[0] : undefined;
  return only ? <TopLevelMenu environment={only} /> : null;
}

export function FoldersSidebarTree(props: {
  sidebar: FoldersSidebar;
  renderProject: RenderProject;
}) {
  const { sidebar } = props;
  const commands = useFolderCommands();
  const start = useStartFromSidebar();
  const editable = useAtomValue(folderEditableEnvironmentsAtom);
  const activeThreadKey = useActiveThreadKey();
  const tree: TreeContext = {
    collapsed: sidebar.collapsed,
    toggle: sidebar.toggle,
    commands,
    start,
  };
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
                  <div className="flex items-center gap-1 ps-2.5 pe-1 pb-1">
                    <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/70">
                      {environment.label}
                    </h3>
                    <TopLevelMenu environment={environment} />
                  </div>
                ) : null}
                <DriveShareDialogHost environmentId={environment.environmentId} />
                <EnvironmentLevels
                  environment={environment}
                  canEdit={editable.has(environment.environmentId)}
                  counts={sidebar.counts.get(environment.environmentId) ?? NO_COUNTS}
                />
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
