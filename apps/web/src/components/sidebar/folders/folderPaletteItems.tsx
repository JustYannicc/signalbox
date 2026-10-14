/**
 * Command palette entries for folders: move the open thread (or draft) to
 * another folder of its owner, and make a new folder.
 */
import { useAtomValue } from "@effect/atom-react";
import { folderDestinations, homeOfThread } from "@t3tools/client-runtime/state/signalboxFolders";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";
import { useParams } from "@tanstack/react-router";
import { FolderInputIcon, FolderPlusIcon } from "lucide-react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useThreadShell } from "../../../state/entities";
import { environmentContextsAtom } from "../../../state/signalboxContexts";
import {
  environmentFoldersAtom,
  folderEditableEnvironmentsAtom,
} from "../../../state/signalboxFolders";
import { resolveThreadRouteTarget } from "../../../threadRoutes";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
} from "../../CommandPalette.logic";
import { openFolderDialog } from "./folderDialogStore";
import { useFolderCommands } from "./useFolderCommands";

export function useFolderPaletteItems(): Array<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const shell = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const folders = useAtomValue(environmentFoldersAtom);
  const contexts = useAtomValue(environmentContextsAtom);
  const editable = useAtomValue(folderEditableEnvironmentsAtom);
  const commands = useFolderCommands();
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  const thread = shell
    ? { environmentId: shell.environmentId, threadId: shell.id, projectId: shell.projectId }
    : draft
      ? { environmentId: draft.environmentId, threadId: draft.threadId, projectId: draft.projectId }
      : null;
  const snapshot = thread ? folders.get(thread.environmentId)?.snapshot : undefined;
  const owner =
    thread &&
    contexts
      .get(thread.environmentId)
      ?.contexts.find((context) => context.projectIds.includes(thread.projectId));
  if (thread && snapshot && owner && editable.has(thread.environmentId)) {
    const home = homeOfThread(snapshot, { id: thread.threadId, projectId: thread.projectId });
    const move = (folderId: FolderId | null) => async () => {
      await commands.moveThread(thread.environmentId, thread.threadId, folderId);
    };
    const destinations: Array<CommandPaletteActionItem> = [
      ...(home === null
        ? []
        : [
            {
              kind: "action" as const,
              value: "move-thread-to-folder:top",
              searchTerms: ["top level", owner.name],
              title: "Top level",
              icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
              run: move(null),
            },
          ]),
      ...folderDestinations(snapshot, owner.id)
        .filter((destination) => destination.folder.id !== home)
        .map((destination): CommandPaletteActionItem => ({
          kind: "action",
          value: `move-thread-to-folder:${destination.folder.id}`,
          searchTerms: [destination.label],
          title: destination.label,
          icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
          run: move(destination.folder.id),
        })),
    ];
    if (destinations.length > 0) {
      items.push({
        kind: "submenu",
        value: "action:move-thread-to-folder",
        searchTerms: ["move thread to folder", "file thread", "folder"],
        title: "Move thread to folder…",
        icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
        groups: [{ value: "folders", label: owner.name, items: destinations }],
      });
    }
  }

  // Every owner whose top level can take a new folder, per environment with folders.
  const owners: Array<CommandPaletteGroup> = [];
  for (const [environmentId, environmentFolders] of folders) {
    const environmentContexts = contexts.get(environmentId);
    if (
      environmentFolders.snapshot === null ||
      environmentContexts === undefined ||
      !editable.has(environmentId)
    ) {
      continue;
    }
    owners.push({
      value: `new-folder:${environmentId}`,
      label: "New folder in",
      items: environmentContexts.contexts.map((context): CommandPaletteActionItem => ({
        kind: "action",
        value: `new-folder:${environmentId}:${context.id}`,
        searchTerms: [context.name],
        title: context.name,
        icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
        run: async () =>
          openFolderDialog({
            kind: "create",
            environmentId,
            ownerId: context.id,
            ownerName: context.name,
            parent: null,
          }),
      })),
    });
  }
  const only = owners.length === 1 && owners[0]!.items.length === 1 ? owners[0]!.items[0] : null;
  if (only?.kind === "action") {
    items.push({
      ...only,
      value: "action:new-folder",
      searchTerms: ["new folder", "create folder", "folder"],
      title: "New folder",
    });
  } else if (owners.length > 0) {
    items.push({
      kind: "submenu",
      value: "action:new-folder",
      searchTerms: ["new folder", "create folder", "folder"],
      title: "New folder…",
      icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
      groups: owners,
    });
  }
  return items;
}
