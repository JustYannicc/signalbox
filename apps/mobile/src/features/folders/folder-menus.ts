/**
 * signalbox: what a folder's ⋯ menu, an owner's top level and a thread offer
 * on Signalbox Cloud, and what each choice means. Native menus report a
 * choice by id; `parse*` turns it back into the change to make.
 */
import { folderDestinations } from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import type {
  Folder,
  FolderId,
  FolderMoveInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

export interface PoolChoice {
  readonly id: string;
  readonly name: string;
}

/** The folder's siblings in order, itself included. */
function siblingsOf(snapshot: SignalboxFoldersSnapshot, folder: Folder): ReadonlyArray<Folder> {
  return snapshot.folders
    .filter(
      (candidate) => candidate.ownerId === folder.ownerId && candidate.parentId === folder.parentId,
    )
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

/** Moves `folder` one place up or down among its siblings; null at the end it's already at. */
export function folderSiblingMoveInput(
  snapshot: SignalboxFoldersSnapshot,
  folder: Folder,
  direction: "up" | "down",
): FolderMoveInput | null {
  const siblings = siblingsOf(snapshot, folder);
  const index = siblings.findIndex((candidate) => candidate.id === folder.id);
  if (index < 0) return null;
  if (direction === "up") {
    const before = siblings[index - 1];
    return before === undefined
      ? null
      : { id: folder.id, parentId: folder.parentId, beforeId: before.id };
  }
  if (index === siblings.length - 1) return null;
  // Absent `beforeId` puts it last.
  const before = siblings[index + 2];
  return before === undefined
    ? { id: folder.id, parentId: folder.parentId }
    : { id: folder.id, parentId: folder.parentId, beforeId: before.id };
}

export function folderMenuActions(input: {
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly folder: Folder;
  readonly pools: ReadonlyArray<PoolChoice>;
}): MenuAction[] {
  const { snapshot, folder } = input;
  const actions: MenuAction[] = [
    { id: "folder:new-child", title: "New folder inside" },
    { id: "folder:rename", title: "Rename" },
    {
      id: "folder:move",
      title: "Move to",
      subactions: [
        {
          id: "folder:parent:top",
          title: "Top level",
          state: folder.parentId === null ? "on" : undefined,
        },
        ...folderDestinations(snapshot, folder.ownerId, folder.id).map((destination) => ({
          id: `folder:parent:${destination.folder.id}`,
          title: destination.label,
          state: folder.parentId === destination.folder.id ? ("on" as const) : undefined,
        })),
      ],
    },
  ];
  if (folderSiblingMoveInput(snapshot, folder, "up") !== null) {
    actions.push({ id: "folder:up", title: "Move up" });
  }
  if (folderSiblingMoveInput(snapshot, folder, "down") !== null) {
    actions.push({ id: "folder:down", title: "Move down" });
  }
  if (input.pools.length > 1) {
    // What it runs on when it picks nothing: whatever the level above it does.
    const inherited =
      folder.parentId === null
        ? snapshot.pools.top
        : snapshot.pools.folders.find((entry) => entry.folderId === folder.parentId)?.pool;
    const inheritedName = input.pools.find((pool) => pool.id === inherited?.poolId)?.name;
    actions.push({
      id: "folder:pool",
      title: "Pool for this folder",
      subactions: [
        {
          id: "folder:pool:inherit",
          title: inheritedName ? `Inherit from above (${inheritedName})` : "Inherit from above",
          state: folder.poolId === undefined ? "on" : undefined,
        },
        ...input.pools.map((pool) => ({
          id: `folder:pool:${pool.id}`,
          title: pool.name,
          state: folder.poolId === pool.id ? ("on" as const) : undefined,
        })),
      ],
    });
  }
  actions.push(
    { id: "folder:instructions", title: "Instructions…" },
    { id: "folder:delete", title: "Delete folder", attributes: { destructive: true } },
  );
  return actions;
}

export type FolderMenuChoice =
  | { readonly _tag: "newChild" }
  | { readonly _tag: "rename" }
  | { readonly _tag: "move"; readonly input: FolderMoveInput }
  | { readonly _tag: "pool"; readonly poolId: AccountPoolId | null }
  | { readonly _tag: "instructions" }
  | { readonly _tag: "delete" };

/** The change a folder menu choice asks for; null when there is nothing to change. */
export function parseFolderMenuEvent(
  snapshot: SignalboxFoldersSnapshot,
  folder: Folder,
  event: string,
): FolderMenuChoice | null {
  if (event === "folder:new-child") return { _tag: "newChild" };
  if (event === "folder:rename") return { _tag: "rename" };
  if (event === "folder:instructions") return { _tag: "instructions" };
  if (event === "folder:delete") return { _tag: "delete" };
  if (event === "folder:up" || event === "folder:down") {
    const input = folderSiblingMoveInput(snapshot, folder, event === "folder:up" ? "up" : "down");
    return input === null ? null : { _tag: "move", input };
  }
  if (event.startsWith("folder:parent:")) {
    const target = event.slice("folder:parent:".length);
    const parentId =
      target === "top"
        ? null
        : (folderDestinations(snapshot, folder.ownerId, folder.id).find(
            (destination) => destination.folder.id === target,
          )?.folder.id ?? undefined);
    if (parentId === undefined || parentId === folder.parentId) return null;
    return { _tag: "move", input: { id: folder.id, parentId } };
  }
  if (event.startsWith("folder:pool:")) {
    const target = event.slice("folder:pool:".length);
    const poolId = target === "inherit" ? null : AccountPoolId.make(target);
    return (folder.poolId ?? null) === poolId ? null : { _tag: "pool", poolId };
  }
  return null;
}

/** An owner's top level. Only Personal's has instructions of its own (`snapshot.top`). */
export function topLevelMenuActions(input: { readonly personal: boolean }): MenuAction[] {
  return [
    { id: "top:new-folder", title: "New folder" },
    ...(input.personal ? [{ id: "top:instructions", title: "Instructions…" }] : []),
  ];
}

/** Where a deleted folder's contents go, in the confirmation. */
export function deleteFolderMessage(snapshot: SignalboxFoldersSnapshot, folder: Folder): string {
  const parent =
    folder.parentId === null
      ? undefined
      : snapshot.folders.find((candidate) => candidate.id === folder.parentId);
  return `Its folders and threads move up to ${parent ? parent.name : "the top level"}. No thread or file is deleted.`;
}

/**
 * "Move to folder" for a thread of `ownerId`'s that lives at `home`: the top
 * level and every folder of the owner's, its home checked. Empty while the
 * owner has no folders, since there's nowhere else to go.
 */
export function threadFolderMenuActions(input: {
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly ownerId: string;
  readonly home: FolderId | null;
}): MenuAction[] {
  const destinations = folderDestinations(input.snapshot, input.ownerId);
  if (destinations.length === 0) return [];
  return [
    {
      id: "thread-folder",
      title: "Move to folder",
      image: "folder",
      subactions: [
        {
          id: "thread-folder:top",
          title: "Top level",
          state: input.home === null ? "on" : undefined,
        },
        ...destinations.map((destination) => ({
          id: `thread-folder:in:${destination.folder.id}`,
          title: destination.label,
          state: input.home === destination.folder.id ? ("on" as const) : undefined,
        })),
      ],
    },
  ];
}

/**
 * The folder a thread menu choice files it in (null: the top level).
 * Undefined when the choice isn't a move, or it's where it already lives.
 */
export function parseThreadFolderMenuEvent(
  input: {
    readonly snapshot: SignalboxFoldersSnapshot;
    readonly ownerId: string;
    readonly home: FolderId | null;
  },
  event: string,
): { readonly folderId: FolderId | null } | undefined {
  if (event === "thread-folder:top") {
    return input.home === null ? undefined : { folderId: null };
  }
  if (!event.startsWith("thread-folder:in:")) return undefined;
  const target = event.slice("thread-folder:in:".length);
  const folder = input.snapshot.folders.find(
    (candidate) => candidate.id === target && candidate.ownerId === input.ownerId,
  );
  if (folder === undefined || folder.id === input.home) return undefined;
  return { folderId: folder.id };
}
