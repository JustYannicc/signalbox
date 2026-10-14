/**
 * The Home sidebar's folders, as plain data: each owner's tree, where each
 * thread lives, how many live below a folder, the threads the sidebar shows
 * (for jump keys and ↑/↓), and where a thread can move. Pure; the
 * components in this folder render it.
 */
import {
  folderDestinations,
  folderTree,
  type FolderNode,
} from "@t3tools/client-runtime/state/signalboxFolders";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sortThreads, type ThreadSortInput } from "@t3tools/client-runtime/state/thread-sort";
import type { ContextMenuItem, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import type {
  SignalboxContext,
  SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

export interface FolderOwner {
  readonly context: SignalboxContext;
  /** The owner's own files: where its top level's threads, and a folder's without files, start. */
  readonly filesProjectId: ProjectId | null;
  readonly roots: ReadonlyArray<FolderNode>;
}

export interface FolderThread extends ThreadSortInput {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
}

/** Where a thread lives in one snapshot (`threadHomeLookup`). */
export type HomeOf = (thread: Pick<FolderThread, "id" | "projectId">) => FolderId | null;

/** An owner with its live threads by home: `null` holds its top level's. */
export interface FolderOwnerThreads<
  Thread extends FolderThread = FolderThread,
> extends FolderOwner {
  readonly threadsByHome: ReadonlyMap<FolderId | null, ReadonlyArray<Thread>>;
}

export function folderOwners(
  contexts: SignalboxContextsSnapshot,
  snapshot: SignalboxFoldersSnapshot,
): ReadonlyArray<FolderOwner> {
  return contexts.contexts.map((context) => ({
    context,
    filesProjectId: context.projectIds[0] ?? null,
    roots: folderTree(snapshot, context.id),
  }));
}

/** Collapse key of an owner's group. */
export const folderOwnerKey = (environmentId: EnvironmentId, ownerId: string) =>
  `folder-owner:${environmentId}:${ownerId}`;

/** Collapse key of a folder. */
export const folderNodeKey = (environmentId: EnvironmentId, folderId: FolderId) =>
  `folder:${environmentId}:${folderId}`;

/** "Show more" key of the threads living at a home: an owner's top level, or a folder. */
export const folderThreadListKey = (
  environmentId: EnvironmentId,
  ownerId: string,
  home: FolderId | null,
) => `folder-threads:${environmentId}:${ownerId}:${home ?? "top"}`;

/**
 * The owner's live threads by home: `null` holds its top level's. Archived
 * threads and threads of other owners are left out.
 */
export function threadsByHome<Thread extends FolderThread>(
  homeOf: HomeOf,
  owner: FolderOwner,
  threads: ReadonlyArray<Thread>,
): ReadonlyMap<FolderId | null, ReadonlyArray<Thread>> {
  const projects = new Set(owner.context.projectIds);
  const byHome = new Map<FolderId | null, Array<Thread>>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || !projects.has(thread.projectId)) continue;
    const home = homeOf(thread);
    const list = byHome.get(home);
    if (list) list.push(thread);
    else byHome.set(home, [thread]);
  }
  return byHome;
}

/** How many threads live in each folder or anywhere below it. */
export function folderThreadCounts(
  roots: ReadonlyArray<FolderNode>,
  byHome: ReadonlyMap<FolderId | null, ReadonlyArray<unknown>>,
): ReadonlyMap<FolderId, number> {
  const counts = new Map<FolderId, number>();
  const count = (node: FolderNode): number => {
    const total = node.children.reduce(
      (sum, child) => sum + count(child),
      byHome.get(node.folder.id)?.length ?? 0,
    );
    counts.set(node.folder.id, total);
    return total;
  };
  for (const root of roots) count(root);
  return counts;
}

/**
 * The thread keys the folder tree shows, in the order it shows them: per
 * owner its top level's threads, then each open folder's subfolders and
 * threads. Mirrors the thread lists' sorting and "Show more".
 */
export function visibleFolderThreadKeys(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly owners: ReadonlyArray<FolderOwnerThreads>;
  }>;
  readonly collapsed: ReadonlySet<string>;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly threadPreviewCount: number;
  readonly expandedThreadLists: ReadonlySet<string>;
}): Array<string> {
  const keys: Array<string> = [];
  for (const environment of input.environments) {
    for (const owner of environment.owners) {
      const ownerId = owner.context.id;
      if (input.collapsed.has(folderOwnerKey(environment.environmentId, ownerId))) continue;
      const pushHome = (home: FolderId | null) => {
        const sorted = sortThreads(owner.threadsByHome.get(home) ?? [], input.threadSortOrder);
        const shown =
          input.expandedThreadLists.has(
            folderThreadListKey(environment.environmentId, ownerId, home),
          ) || sorted.length <= input.threadPreviewCount
            ? sorted
            : sorted.slice(0, input.threadPreviewCount);
        for (const thread of shown) {
          keys.push(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
        }
      };
      const visit = (node: FolderNode) => {
        if (input.collapsed.has(folderNodeKey(environment.environmentId, node.folder.id))) return;
        for (const child of node.children) visit(child);
        pushHome(node.folder.id);
      };
      pushHome(null);
      for (const root of owner.roots) visit(root);
    }
  }
  return keys;
}

const MOVE_TO_FOLDER = "move-to-folder:";
const TOP_LEVEL = "top";

/**
 * The thread menu's "Move to folder…": its owner's top level and every
 * folder, its current home checked.
 */
export function moveThreadMenuItem(
  snapshot: SignalboxFoldersSnapshot,
  ownerId: string,
  home: FolderId | null,
): ContextMenuItem<string> {
  return {
    id: `${MOVE_TO_FOLDER}menu`,
    label: "Move to folder…",
    children: [
      {
        id: `${MOVE_TO_FOLDER}${TOP_LEVEL}`,
        label: "Top level",
        checked: home === null,
        disabled: home === null,
      },
      ...folderDestinations(snapshot, ownerId).map((destination) => ({
        id: `${MOVE_TO_FOLDER}${destination.folder.id}`,
        label: destination.label,
        checked: destination.folder.id === home,
        disabled: destination.folder.id === home,
      })),
    ],
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
