import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type {
  Folder,
  FolderId,
  FolderLevel,
  FolderMoveInput,
  FolderResolvedPool,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

/**
 * A Signalbox Cloud user's tree as clients show it (`signalboxFolders.ts`):
 * every owner's folders nested, where each thread lives, and what a level
 * runs on. Pure; web and mobile both read their sidebars from it. Lookups
 * that every row needs are cached per snapshot, so they keep their identity
 * until the folders change.
 */

export interface FolderNode {
  readonly folder: Folder;
  readonly children: ReadonlyArray<FolderNode>;
}

/** Position order, ties broken by id like the server's. */
const byPosition = (left: Folder, right: Folder) =>
  left.position - right.position || left.id.localeCompare(right.id);

const treeCache = new WeakMap<
  SignalboxFoldersSnapshot,
  Map<SignalboxContextId, ReadonlyArray<FolderNode>>
>();

/** One owner's folders, nested, in order. The same array for the same snapshot. */
export function folderTree(
  snapshot: SignalboxFoldersSnapshot,
  ownerId: SignalboxContextId,
): ReadonlyArray<FolderNode> {
  const trees = treeCache.get(snapshot) ?? new Map();
  treeCache.set(snapshot, trees);
  const cached = trees.get(ownerId);
  if (cached !== undefined) return cached;
  const children = new Map<FolderId | null, Array<Folder>>();
  for (const folder of snapshot.folders) {
    if (folder.ownerId !== ownerId) continue;
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  const build = (parentId: FolderId | null, seen: ReadonlySet<FolderId>): Array<FolderNode> =>
    // Hermes (mobile) has no Array#toSorted; `filter` copies before the in-place sort.
    (children.get(parentId) ?? [])
      .filter((folder) => !seen.has(folder.id))
      .sort(byPosition)
      .map((folder) => ({
        folder,
        children: build(folder.id, new Set([...seen, folder.id])),
      }));
  const tree = build(null, new Set());
  trees.set(ownerId, tree);
  return tree;
}

/** The files an owner's own threads work in: Scratch for Personal, `context:<org>` for an organization. */
export function ownerFilesProject(context: SignalboxContext): ProjectId | null {
  return context.projectIds[0] ?? null;
}

export interface ThreadRef {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
}

/**
 * Where a thread lives: where it was filed, else the folder whose files its
 * project is, else its owner's top level (null).
 */
export function homeOfThread(
  snapshot: SignalboxFoldersSnapshot,
  thread: ThreadRef,
): FolderId | null {
  return threadHomeLookup(snapshot)(thread);
}

/** Where a project's threads live unless filed elsewhere: the folder it's the files of, else the top level. */
export function homeOfProject(
  snapshot: SignalboxFoldersSnapshot,
  projectId: ProjectId,
): FolderId | null {
  return snapshot.projectHomes.find((home) => home.projectId === projectId)?.folderId ?? null;
}

/**
 * Whether a thread was filed away from where its project's threads live, like
 * a draft started in a folder that shares its owner's files.
 */
export function isFiledAway(snapshot: SignalboxFoldersSnapshot, thread: ThreadRef): boolean {
  return homeOfThread(snapshot, thread) !== homeOfProject(snapshot, thread.projectId);
}

const lookupCache = new WeakMap<SignalboxFoldersSnapshot, (thread: ThreadRef) => FolderId | null>();

/** Each thread's home, for grouping many threads at once. The same function for the same snapshot. */
export function threadHomeLookup(
  snapshot: SignalboxFoldersSnapshot,
): (thread: ThreadRef) => FolderId | null {
  const cached = lookupCache.get(snapshot);
  if (cached !== undefined) return cached;
  const filed = new Map(snapshot.threadHomes.map((home) => [home.threadId, home.folderId]));
  const byProject = new Map(snapshot.projectHomes.map((home) => [home.projectId, home.folderId]));
  const lookup = (thread: ThreadRef): FolderId | null =>
    filed.has(thread.id)
      ? (filed.get(thread.id) ?? null)
      : (byProject.get(thread.projectId) ?? null);
  lookupCache.set(snapshot, lookup);
  return lookup;
}

/** The pool a level runs on: null when nothing on its chain has one. */
export function poolOfHome(
  snapshot: SignalboxFoldersSnapshot,
  home: FolderId | null,
): FolderResolvedPool | null {
  if (home === null) return snapshot.pools.top;
  return snapshot.pools.folders.find((entry) => entry.folderId === home)?.pool ?? null;
}

/**
 * The pool something runs on: a folder (where a thread is being started),
 * else a thread (its home), else a new thread in a project (its project's
 * home), else the top level.
 */
export function poolOfTarget(
  snapshot: SignalboxFoldersSnapshot,
  target: {
    readonly projectId: ProjectId | null;
    readonly threadId?: ThreadId | null | undefined;
    readonly folderId?: FolderId | null | undefined;
  },
): FolderResolvedPool | null {
  if (target.folderId !== undefined) return poolOfHome(snapshot, target.folderId);
  if (target.projectId === null) return poolOfHome(snapshot, null);
  const home =
    target.threadId == null
      ? homeOfProject(snapshot, target.projectId)
      : homeOfThread(snapshot, { id: target.threadId, projectId: target.projectId });
  return poolOfHome(snapshot, home);
}

/** Where a pool is placed, as "Runs on X · from Y" names it: null when that folder is gone. */
export function folderLevelName(
  snapshot: SignalboxFoldersSnapshot,
  level: FolderLevel,
): string | null {
  if (level._tag === "top") return "the top level";
  return snapshot.folders.find((folder) => folder.id === level.folderId)?.name ?? null;
}

/** `folderId` and the folders above it, top first; empty for the top level. */
export function folderPath(
  snapshot: SignalboxFoldersSnapshot,
  folderId: FolderId | null,
): ReadonlyArray<Folder> {
  const byId = new Map(snapshot.folders.map((folder) => [folder.id, folder]));
  const path: Array<Folder> = [];
  const seen = new Set<FolderId>();
  for (let id = folderId; id !== null && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
    seen.add(id);
    const folder = byId.get(id);
    if (folder === undefined) break;
    path.unshift(folder);
  }
  return path;
}

export interface FolderDestination {
  readonly folder: Folder;
  /** Names from the top level down, this folder's last: "Work / Clients". */
  readonly label: string;
  readonly depth: number;
}

/**
 * Where something of `ownerId`'s can go, in tree order. `moving`: a folder
 * that can't go inside itself, so it and everything under it are left out.
 */
export function folderDestinations(
  snapshot: SignalboxFoldersSnapshot,
  ownerId: SignalboxContextId,
  moving?: FolderId,
): ReadonlyArray<FolderDestination> {
  const destinations: Array<FolderDestination> = [];
  const walk = (nodes: ReadonlyArray<FolderNode>, path: ReadonlyArray<string>) => {
    for (const node of nodes) {
      if (node.folder.id === moving) continue;
      const names = [...path, node.folder.name];
      destinations.push({ folder: node.folder, label: names.join(" / "), depth: path.length });
      walk(node.children, names);
    }
  };
  walk(folderTree(snapshot, ownerId), []);
  return destinations;
}

export interface ThreadFolderChoice {
  /** Null: the owner's top level. */
  readonly folderId: FolderId | null;
  readonly label: string;
  /** Where the thread lives now. */
  readonly checked: boolean;
}

/** Where a thread living at `home` can be moved: its owner's top level, then every folder. */
export function threadFolderChoices(
  snapshot: SignalboxFoldersSnapshot,
  ownerId: SignalboxContextId,
  home: FolderId | null,
): ReadonlyArray<ThreadFolderChoice> {
  return [
    { folderId: null, label: "Top level", checked: home === null },
    ...folderDestinations(snapshot, ownerId).map((destination) => ({
      folderId: destination.folder.id,
      label: destination.label,
      checked: destination.folder.id === home,
    })),
  ];
}

/** What deleting `folder` does, for its confirmation. */
export function folderDeleteMessage(snapshot: SignalboxFoldersSnapshot, folder: Folder): string {
  const parent = snapshot.folders.find((candidate) => candidate.id === folder.parentId);
  return `Its folders and threads move up to ${
    parent === undefined ? "the top level" : `“${parent.name}”`
  }. No thread or file is deleted.`;
}

/**
 * How many live threads are in each folder or anywhere below it, by their
 * home. Archived threads don't count.
 */
export function folderThreadCounts(
  snapshot: SignalboxFoldersSnapshot,
  residents: ReadonlyArray<ThreadRef & { readonly archivedAt?: string | null }>,
): ReadonlyMap<FolderId, number> {
  const homeOf = threadHomeLookup(snapshot);
  const parentOf = new Map(snapshot.folders.map((folder) => [folder.id, folder.parentId]));
  const counts = new Map<FolderId, number>();
  for (const thread of residents) {
    if (thread.archivedAt != null) continue;
    const seen = new Set<FolderId>();
    for (let id = homeOf(thread); id !== null && !seen.has(id); id = parentOf.get(id) ?? null) {
      seen.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The move that swaps a folder with its sibling above or below; null at
 * either end. Moving down goes before the folder two places on, or last.
 */
export function folderSiblingMove(
  snapshot: SignalboxFoldersSnapshot,
  folderId: FolderId,
  direction: "up" | "down",
): FolderMoveInput | null {
  const folder = snapshot.folders.find((candidate) => candidate.id === folderId);
  if (folder === undefined) return null;
  const siblings = snapshot.folders
    .filter(
      (candidate) => candidate.ownerId === folder.ownerId && candidate.parentId === folder.parentId,
    )
    .sort(byPosition);
  const index = siblings.findIndex((candidate) => candidate.id === folderId);
  if (direction === "up") {
    const before = siblings[index - 1];
    return before === undefined
      ? null
      : { id: folderId, parentId: folder.parentId, beforeId: before.id };
  }
  if (index >= siblings.length - 1) return null;
  const after = siblings[index + 2];
  return after === undefined
    ? { id: folderId, parentId: folder.parentId }
    : { id: folderId, parentId: folder.parentId, beforeId: after.id };
}

/**
 * How to start a thread in `folderId`: the project it works in (the folder's
 * files, else the owner's own) and whether it has to be filed there, because
 * that project's threads live somewhere else.
 */
export function newThreadIn(
  snapshot: SignalboxFoldersSnapshot,
  folderId: FolderId | null,
  ownerProjectId: ProjectId,
): { readonly projectId: ProjectId; readonly file: boolean } {
  const folder =
    folderId === null ? undefined : snapshot.folders.find((candidate) => candidate.id === folderId);
  const projectId = folder?.files?.projectId ?? ownerProjectId;
  return { projectId, file: homeOfProject(snapshot, projectId) !== folderId };
}
