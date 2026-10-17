/**
 * The Home sidebar's folders, as plain data: each owner's tree, which list
 * each thread shows in, each list's threads, the lists the sidebar shows
 * (for jump keys and ↑/↓), and the thread menu's "Move to folder…". Pure;
 * the components in this folder render it.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  folderPath,
  folderTree,
  ownerFilesProject,
  ownerLevelName,
  ownerLevels,
  type FolderNode,
  type ThreadFolderChoice,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { ContextMenuItem, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  SignalboxContext,
  SignalboxContextId,
  SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

export interface FolderOwner {
  readonly context: SignalboxContext;
  /** The owner's own files: where its top level's threads, and a folder's without files, start. */
  readonly filesProjectId: ProjectId | null;
  readonly roots: ReadonlyArray<FolderNode>;
}

/** Personal first, then each organization, in the contexts' order. */
export function folderOwners(
  contexts: SignalboxContextsSnapshot,
  snapshot: SignalboxFoldersSnapshot,
): ReadonlyArray<FolderOwner> {
  return contexts.contexts.map((context) => ({
    context,
    filesProjectId: ownerFilesProject(context),
    roots: folderTree(snapshot, context.id),
  }));
}

/** Which owner holds each project. */
export function projectOwners(owners: ReadonlyArray<FolderOwner>): Map<ProjectId, FolderOwner> {
  const ownerOf = new Map<ProjectId, FolderOwner>();
  for (const owner of owners) {
    for (const projectId of owner.context.projectIds) ownerOf.set(projectId, owner);
  }
  return ownerOf;
}

/**
 * Where something lives, as headers name it: the folder path ("Work / Clients"),
 * or the level it sits at the top of ("Top level", an organization's name).
 */
export function homeLabel(
  snapshot: SignalboxFoldersSnapshot,
  owner: SignalboxContext,
  home: FolderId | null,
): string {
  const path = folderPath(snapshot, home);
  return path.length === 0 ? ownerLevelName(owner) : path.map((folder) => folder.name).join(" / ");
}

/** Collapse key of an owner's group. */
export const folderOwnerKey = (environmentId: EnvironmentId, ownerId: SignalboxContextId) =>
  `folder-owner:${environmentId}:${ownerId}`;

/** Collapse key of a folder. */
export const folderNodeKey = (environmentId: EnvironmentId, folderId: FolderId) =>
  `folder:${environmentId}:${folderId}`;

/** The thread list of a home: an owner's top level, or a folder. Also its "Show more" key. */
export type FolderListKey = `folder-threads:${string}`;

export const folderThreadListKey = (
  environmentId: EnvironmentId,
  ownerId: SignalboxContextId,
  home: FolderId | null,
): FolderListKey => `folder-threads:${environmentId}:${ownerId}:${home ?? "top"}`;

/** Whether two maps hold the same values by identity, so the previous one can be kept. */
export function sameEntries<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value || !right.has(key)) return false;
  }
  return true;
}

/** What decides where a thread shows: not its title or status, so those don't regroup. */
export interface FolderResident {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
}

export function sameResidents(
  left: ReadonlyArray<FolderResident>,
  right: ReadonlyArray<FolderResident>,
): boolean {
  return (
    left.length === right.length &&
    left.every((thread, index) => {
      const other = right[index]!;
      return (
        thread.id === other.id &&
        thread.environmentId === other.environmentId &&
        thread.projectId === other.projectId &&
        thread.archivedAt === other.archivedAt
      );
    })
  );
}

/**
 * The list each live thread of one environment shows in, by thread key:
 * its owner's list for its home. Threads of no owner, and archived ones,
 * show nowhere.
 */
export function folderListOfThreads(
  environmentId: EnvironmentId,
  owners: ReadonlyArray<FolderOwner>,
  homeOf: (thread: FolderResident) => FolderId | null,
  residents: ReadonlyArray<FolderResident>,
): ReadonlyMap<string, FolderListKey> {
  const ownerOf = projectOwners(owners);
  const lists = new Map<string, FolderListKey>();
  for (const thread of residents) {
    if (thread.environmentId !== environmentId || thread.archivedAt !== null) continue;
    const ownerId = ownerOf.get(thread.projectId)?.context.id;
    if (ownerId === undefined) continue;
    lists.set(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      folderThreadListKey(environmentId, ownerId, homeOf(thread)),
    );
  }
  return lists;
}

/**
 * Each list's threads, in `threads`' order. A list whose threads are all the
 * same objects as before keeps its previous array, and with nothing changed
 * the previous map comes back, so unchanged lists don't redraw.
 */
export function sliceFolderThreads<
  Thread extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  threads: ReadonlyArray<Thread>,
  listOf: ReadonlyMap<string, FolderListKey>,
  previous: ReadonlyMap<FolderListKey, ReadonlyArray<Thread>> | undefined,
): ReadonlyMap<FolderListKey, ReadonlyArray<Thread>> {
  const slices = new Map<FolderListKey, Array<Thread>>();
  for (const thread of threads) {
    const list = listOf.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
    if (list === undefined) continue;
    const slice = slices.get(list);
    if (slice) slice.push(thread);
    else slices.set(list, [thread]);
  }
  const kept = new Map<FolderListKey, ReadonlyArray<Thread>>();
  for (const [list, slice] of slices) {
    const before = previous?.get(list);
    kept.set(list, before !== undefined && arrayElementsEqual(before, slice) ? before : slice);
  }
  return previous !== undefined && sameEntries(previous, kept) ? previous : kept;
}

export interface VisibleFolderList {
  readonly environmentId: EnvironmentId;
  readonly owner: FolderOwner;
  readonly home: FolderId | null;
  readonly listKey: FolderListKey;
}

/**
 * The thread lists the tree shows, in the order it shows them: your top
 * level's, then each open folder's subfolders' and its own, then the same for
 * each open member level. Your top level has no row, so it never folds.
 */
export function visibleFolderLists(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly owners: ReadonlyArray<FolderOwner>;
  }>,
  collapsed: ReadonlySet<string>,
): Array<VisibleFolderList> {
  const lists: Array<VisibleFolderList> = [];
  for (const { environmentId, owners } of environments) {
    const { top, members } = ownerLevels(owners, (owner) => owner.context);
    for (const owner of top ? [top, ...members] : members) {
      const ownerId = owner.context.id;
      if (owner !== top && collapsed.has(folderOwnerKey(environmentId, ownerId))) continue;
      const push = (home: FolderId | null) =>
        lists.push({
          environmentId,
          owner,
          home,
          listKey: folderThreadListKey(environmentId, ownerId, home),
        });
      const visit = (node: FolderNode) => {
        if (collapsed.has(folderNodeKey(environmentId, node.folder.id))) return;
        for (const child of node.children) visit(child);
        push(node.folder.id);
      };
      push(null);
      for (const root of owner.roots) visit(root);
    }
  }
  return lists;
}

const MOVE_TO_FOLDER = "move-to-folder:";
const TOP_LEVEL = "top";

/** The thread menu's "Move to folder…" for `threadFolderChoices`. */
export function moveThreadMenuItem(
  choices: ReadonlyArray<ThreadFolderChoice>,
  disabled: boolean,
): ContextMenuItem<string> {
  return {
    id: `${MOVE_TO_FOLDER}menu`,
    label: "Move to folder…",
    disabled,
    children: choices.map((choice) => ({
      id: `${MOVE_TO_FOLDER}${choice.folderId ?? TOP_LEVEL}`,
      label: choice.label,
      checked: choice.checked,
      disabled: choice.checked,
    })),
  };
}

/** The folder a "Move to folder…" choice files the thread in: null for the top level. */
export function movedThreadDestination(
  clicked: string | null,
): { readonly folderId: FolderId | null } | null {
  if (clicked === null || !clicked.startsWith(MOVE_TO_FOLDER)) return null;
  const target = clicked.slice(MOVE_TO_FOLDER.length);
  if (target === "menu") return null;
  return { folderId: target === TOP_LEVEL ? null : FolderId.make(target) };
}
