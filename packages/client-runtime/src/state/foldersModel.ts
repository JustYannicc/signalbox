import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  Folder,
  FolderId,
  FolderMoveInput,
  FolderResolvedPool,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

/**
 * A Signalbox Cloud user's tree as clients show it (`signalboxFolders.ts`):
 * every owner's folders nested, where each thread lives, and what a level
 * runs on. Pure; web and mobile both read their sidebars from it.
 */

export interface FolderNode {
  readonly folder: Folder;
  readonly children: ReadonlyArray<FolderNode>;
}

/** Position order, ties broken by id like the server's. */
const byPosition = (left: Folder, right: Folder) =>
  left.position - right.position || left.id.localeCompare(right.id);

/** One owner's folders, nested, in order. */
export function folderTree(
  snapshot: SignalboxFoldersSnapshot,
  ownerId: string,
): ReadonlyArray<FolderNode> {
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
  return build(null, new Set());
}

/**
 * Where a thread lives: where it was filed, else the folder whose files its
 * project is, else its owner's top level (null).
 */
export function homeOfThread(
  snapshot: SignalboxFoldersSnapshot,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): FolderId | null {
  const filed = snapshot.threadHomes.find((home) => home.threadId === thread.id);
  if (filed !== undefined) return filed.folderId;
  return (
    snapshot.projectHomes.find((home) => home.projectId === thread.projectId)?.folderId ?? null
  );
}

/** Where a project's threads live unless filed elsewhere: the folder it's the files of, else the top level. */
export function homeOfProject(
  snapshot: SignalboxFoldersSnapshot,
  projectId: ProjectId,
): FolderId | null {
  return snapshot.projectHomes.find((home) => home.projectId === projectId)?.folderId ?? null;
}

/** Each thread's home, for grouping many threads at once. */
export function threadHomeLookup(snapshot: SignalboxFoldersSnapshot) {
  const filed = new Map(snapshot.threadHomes.map((home) => [home.threadId, home.folderId]));
  const byProject = new Map(snapshot.projectHomes.map((home) => [home.projectId, home.folderId]));
  return (thread: { readonly id: ThreadId; readonly projectId: ProjectId }): FolderId | null =>
    filed.has(thread.id)
      ? (filed.get(thread.id) ?? null)
      : (byProject.get(thread.projectId) ?? null);
}

/** The pool a level runs on: null when nothing on its chain has one. */
export function poolOfHome(
  snapshot: SignalboxFoldersSnapshot,
  home: FolderId | null,
): FolderResolvedPool | null {
  if (home === null) return snapshot.pools.top;
  return snapshot.pools.folders.find((entry) => entry.folderId === home)?.pool ?? null;
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
  ownerId: string,
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
  const projectHome =
    snapshot.projectHomes.find((home) => home.projectId === projectId)?.folderId ?? null;
  return { projectId, file: projectHome !== folderId };
}
