/**
 * signalbox: what a folder's ⋯ menu, an owner's top level and a thread offer
 * on Signalbox Cloud, and what each choice means. Native menus report a
 * choice by id; `parse*` turns it back into the change to make.
 */
import {
  folderDestinations,
  folderSiblingMove,
  poolOfHome,
  type ThreadFolderChoice,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { MenuAction } from "@react-native-menu/menu";
import type { AccountPoolId } from "@t3tools/contracts/accountHub";
import type {
  Folder,
  FolderId,
  FolderMoveInput,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

export interface PoolChoice {
  readonly id: AccountPoolId;
  readonly name: string;
}

export function folderMenuActions(input: {
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly folder: Folder;
  readonly pools: ReadonlyArray<PoolChoice>;
  readonly canStartFrom: boolean;
}): MenuAction[] {
  const { snapshot, folder } = input;
  const actions: MenuAction[] = [
    { id: "folder:new-child", title: "New folder inside" },
    ...(input.canStartFrom ? [{ id: "folder:start-from", title: "Start a folder from here" }] : []),
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
  if (folderSiblingMove(snapshot, folder.id, "up") !== null) {
    actions.push({ id: "folder:up", title: "Move up" });
  }
  if (folderSiblingMove(snapshot, folder.id, "down") !== null) {
    actions.push({ id: "folder:down", title: "Move down" });
  }
  // A pool set here can always be reset, even when it's the only one left.
  if (folder.poolId !== undefined || input.pools.length > 1) {
    // What it runs on when it picks nothing: whatever the level above it does.
    const inherited = poolOfHome(snapshot, folder.parentId);
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
  | { readonly _tag: "startFrom" }
  | { readonly _tag: "rename" }
  | { readonly _tag: "move"; readonly input: FolderMoveInput }
  | { readonly _tag: "pool"; readonly poolId: AccountPoolId | null }
  | { readonly _tag: "instructions" }
  | { readonly _tag: "delete" };

/** The change a folder menu choice asks for; null when there is nothing to change. */
export function parseFolderMenuEvent(input: {
  readonly snapshot: SignalboxFoldersSnapshot;
  readonly folder: Folder;
  readonly pools: ReadonlyArray<PoolChoice>;
  readonly event: string;
}): FolderMenuChoice | null {
  const { snapshot, folder, event } = input;
  if (event === "folder:new-child") return { _tag: "newChild" };
  if (event === "folder:start-from") return { _tag: "startFrom" };
  if (event === "folder:rename") return { _tag: "rename" };
  if (event === "folder:instructions") return { _tag: "instructions" };
  if (event === "folder:delete") return { _tag: "delete" };
  if (event === "folder:up" || event === "folder:down") {
    const move = folderSiblingMove(snapshot, folder.id, event === "folder:up" ? "up" : "down");
    return move === null ? null : { _tag: "move", input: move };
  }
  if (event.startsWith("folder:parent:")) {
    const target = event.slice("folder:parent:".length);
    const parentId: FolderId | null | undefined =
      target === "top"
        ? null
        : folderDestinations(snapshot, folder.ownerId, folder.id).find(
            (destination) => destination.folder.id === target,
          )?.folder.id;
    if (parentId === undefined || parentId === folder.parentId) return null;
    return { _tag: "move", input: { id: folder.id, parentId } };
  }
  if (event.startsWith("folder:pool:")) {
    const target = event.slice("folder:pool:".length);
    const poolId = target === "inherit" ? null : input.pools.find((pool) => pool.id === target)?.id;
    if (poolId === undefined || (folder.poolId ?? null) === poolId) return null;
    return { _tag: "pool", poolId };
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

/** Every menu event for moving a thread starts with this. */
export const THREAD_FOLDER_EVENT = "thread-folder";

/**
 * "Move to folder" from `threadFolderChoices`. Empty while there's only the
 * top level, since there's nowhere else to go.
 */
export function threadFolderMenuActions(choices: ReadonlyArray<ThreadFolderChoice>): MenuAction[] {
  if (choices.length <= 1) return [];
  return [
    {
      id: THREAD_FOLDER_EVENT,
      title: "Move to folder",
      image: "folder",
      subactions: choices.map((choice) => ({
        id:
          choice.folderId === null
            ? `${THREAD_FOLDER_EVENT}:top`
            : `${THREAD_FOLDER_EVENT}:in:${choice.folderId}`,
        title: choice.label,
        state: choice.checked ? ("on" as const) : undefined,
      })),
    },
  ];
}

/**
 * The folder a thread menu choice files it in (null: the top level).
 * Undefined when the choice isn't a move, or it's where it already lives.
 */
export function parseThreadFolderMenuEvent(
  choices: ReadonlyArray<ThreadFolderChoice>,
  event: string,
): { readonly folderId: FolderId | null } | undefined {
  const choice = choices.find(
    (candidate) =>
      event ===
      (candidate.folderId === null
        ? `${THREAD_FOLDER_EVENT}:top`
        : `${THREAD_FOLDER_EVENT}:in:${candidate.folderId}`),
  );
  return choice === undefined || choice.checked ? undefined : { folderId: choice.folderId };
}
