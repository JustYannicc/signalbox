import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  FolderId,
  FolderLevel,
  FolderResolvedPool,
  FolderPhase,
  FolderOrigin,
  OnePasswordEnvironmentId,
} from "@t3tools/contracts/signalboxFolders";
import type { SignalboxContext, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { FolderInstructions } from "@signalbox/runner-protocol/DriveProtocol";

import { projectIdForDrive } from "./contextProjects.ts";
import { chainOf, type PoolTree, resolvePool } from "./poolChain.ts";
import type { PoolBinding } from "./ResourceBindings.ts";

/**
 * A user's tree, decided without storage: where a thread lives, what its
 * chain is, and what that chain gives it. `UserFolders` reads the tree and
 * applies changes; everything here is pure.
 *
 * Every thread has one home: the folder it was filed in, else the folder
 * whose files its project is, else its owner's top level. A home always sits
 * in its thread's owner's tree; a filing that doesn't is ignored.
 */

export interface TreeFolder {
  readonly id: FolderId;
  readonly ownerId: SignalboxContextId;
  /** Always one of the same owner's folders, without a cycle (`withSoundParents`), or null. */
  readonly parentId: FolderId | null;
  readonly name: string;
  readonly position: number;
  /** The drive it uses as its files, if any. */
  readonly driveId: string | null;
  /** The immutable source lineage, when this folder started from another. */
  readonly origin?: FolderOrigin | null;
  /** Never blank: no instructions is null. */
  readonly instructions: string | null;
  /** The 1Password Environment its threads get, if any. */
  readonly secrets: OnePasswordEnvironmentId | null;
  /** Where it is in its life (`folderPhases.ts`), if it has a phase. */
  readonly phase: FolderPhase | null;
}

export interface Tree {
  /** Folders of the user's current owners only. */
  readonly folders: ReadonlyArray<TreeFolder>;
  readonly topInstructions: string | null;
  readonly topSecrets: OnePasswordEnvironmentId | null;
  readonly bindings: ReadonlyArray<PoolBinding>;
  /** Threads filed explicitly, by thread id. Null: the top level. */
  readonly filed: ReadonlyMap<ThreadId, FolderId | null>;
  /** The drive a project's threads work in, or null for a project that names none. */
  readonly driveOfProject: (projectId: ProjectId) => string | null;
}

const TOP: FolderLevel = { _tag: "top" };

export const levelOf = (folderId: FolderId | null): FolderLevel =>
  folderId === null ? TOP : { _tag: "folder", folderId };

const indexed = (folders: ReadonlyArray<TreeFolder>) =>
  new Map(folders.map((folder) => [folder.id, folder]));

/**
 * `folders` with every parent that's gone, of another owner's or part of a
 * cycle replaced by the top level, so every chain reaches the top. Changes
 * never make such a parent; rows taken from elsewhere (`adopt`) might.
 */
export const withSoundParents = (folders: ReadonlyArray<TreeFolder>): ReadonlyArray<TreeFolder> => {
  const byId = indexed(folders);
  const atTop = (folder: TreeFolder) => ({ ...folder, parentId: null });
  return folders.map((folder) => {
    const parent = folder.parentId === null ? undefined : byId.get(folder.parentId);
    if (folder.parentId === null) return folder;
    if (parent === undefined || parent.ownerId !== folder.ownerId) return atTop(folder);
    // Every folder of a cycle goes to the top; one only leading into it keeps its parent.
    const seen = new Set<FolderId>();
    for (
      let id: FolderId | null = folder.parentId;
      id !== null;
      id = byId.get(id)?.parentId ?? null
    ) {
      if (id === folder.id) return atTop(folder);
      if (seen.has(id)) return folder;
      seen.add(id);
    }
    return folder;
  });
};

/** The tree as pools see it: a folder sits in its parent, or at the top level. */
export const poolTreeOf = (tree: Tree): PoolTree => {
  const byId = indexed(tree.folders);
  return {
    parentOf: (level) =>
      level._tag === "top" ? null : levelOf(byId.get(level.folderId)?.parentId ?? null),
    bindings: tree.bindings,
  };
};

/** The folder whose files `projectId` is, or null: its threads live at the top level. */
export const folderOfProject = (tree: Tree, projectId: ProjectId): FolderId | null => {
  const driveId = tree.driveOfProject(projectId);
  if (driveId === null) return null;
  return tree.folders.find((folder) => folder.driveId === driveId)?.id ?? null;
};

/** Every project of the user's current owners. */
export const currentProjectIds = (contexts: ReadonlyArray<SignalboxContext>) =>
  contexts.flatMap((context) => context.projectIds);

/** The project a folder's files are, when its drive is one the user still has. */
export const filesProjectOf = (folder: TreeFolder, given: ReadonlySet<string>) =>
  folder.driveId !== null && given.has(folder.driveId) ? projectIdForDrive(folder.driveId) : null;

/** The pool placed at each folder, by folder id. */
export const ownPools = (tree: Tree): ReadonlyMap<FolderId, string> =>
  new Map(
    tree.bindings.flatMap((binding) =>
      binding.level._tag === "folder" ? [[binding.level.folderId, binding.poolId] as const] : [],
    ),
  );

/**
 * Where a thread lives. `projectId` is null when the thread isn't known here;
 * `ownerId` is the tree it belongs to, when known.
 */
export const homeOf = (
  tree: Tree,
  thread: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | null;
    readonly ownerId: SignalboxContextId | null;
  },
): FolderId | null => {
  const fallback = thread.projectId === null ? null : folderOfProject(tree, thread.projectId);
  if (!tree.filed.has(thread.threadId)) return fallback;
  const filed = tree.filed.get(thread.threadId) ?? null;
  if (filed === null) return null;
  const folder = tree.folders.find((candidate) => candidate.id === filed);
  return folder !== undefined && (thread.ownerId === null || folder.ownerId === thread.ownerId)
    ? folder.id
    : fallback;
};

/**
 * The `AGENTS.md` of every level on `home`'s chain that has one: the top
 * level first, then each folder down, labeled with its path ("Work / Clients").
 */
export const instructionsOf = (
  tree: Tree,
  home: FolderId | null,
): ReadonlyArray<FolderInstructions> => {
  const byId = indexed(tree.folders);
  const found: Array<FolderInstructions> = [];
  const path: Array<string> = [];
  for (const level of chainOf(poolTreeOf(tree), levelOf(home)).toReversed()) {
    if (level._tag === "top") {
      if (tree.topInstructions !== null) {
        found.push({ label: "Top level", text: tree.topInstructions });
      }
      continue;
    }
    const folder = byId.get(level.folderId);
    path.push(folder?.name ?? "");
    if (folder?.instructions != null) {
      found.push({ label: path.join(" / "), text: folder.instructions });
    }
  }
  return found;
};

/**
 * The 1Password Environment of every level on `home`'s chain that names one,
 * the top level first, so a nearer folder's variable replaces one from above.
 */
export const secretsOf = (
  tree: Tree,
  home: FolderId | null,
): ReadonlyArray<OnePasswordEnvironmentId> => {
  const byId = indexed(tree.folders);
  return chainOf(poolTreeOf(tree), levelOf(home))
    .toReversed()
    .flatMap((level) => {
      const environmentId =
        level._tag === "top" ? tree.topSecrets : (byId.get(level.folderId)?.secrets ?? null);
      return environmentId === null ? [] : [environmentId];
    });
};

/** Resolves pools per home, each home once: `turn` and snapshots ask for many. */
export const poolResolver = (tree: Tree) => {
  const pools = poolTreeOf(tree);
  const resolved = new Map<FolderId | null, FolderResolvedPool | null>();
  return (home: FolderId | null): FolderResolvedPool | null => {
    if (!resolved.has(home)) resolved.set(home, resolvePool(pools, levelOf(home)));
    return resolved.get(home) ?? null;
  };
};

/** Whether `folderId` is `ancestorId` or anywhere under it. */
export const isWithin = (tree: Tree, folderId: FolderId, ancestorId: FolderId): boolean =>
  chainOf(poolTreeOf(tree), levelOf(folderId)).some(
    (level) => level._tag === "folder" && level.folderId === ancestorId,
  );

/** Position order, ties broken by id like the clients'. */
export const byPosition = (folders: ReadonlyArray<TreeFolder>) =>
  folders.toSorted(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );

/** `ids` with `id` moved before `beforeId`, or to the end; undefined when the anchor isn't there. */
export const insertBefore = (ids: ReadonlyArray<FolderId>, id: FolderId, beforeId?: FolderId) => {
  const without = ids.filter((candidate) => candidate !== id);
  const index = beforeId === undefined ? without.length : without.indexOf(beforeId);
  return index < 0 ? undefined : [...without.slice(0, index), id, ...without.slice(index)];
};

export const sameOrder = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** The folder's children in order: the owner's top-level folders for a null parent. */
export const childIds = (tree: Tree, ownerId: SignalboxContextId, parentId: FolderId | null) =>
  byPosition(
    tree.folders.filter((folder) => folder.ownerId === ownerId && folder.parentId === parentId),
  ).map((folder) => folder.id);
