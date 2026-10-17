/**
 * Command palette entries for folders: move the open thread (or draft) to
 * another folder of its owner, move its folder to another phase, and make a
 * new folder.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  homeOfThread,
  ownerLevelName,
  threadFolderChoices,
} from "@t3tools/client-runtime/state/signalboxFolders";
import { useParams } from "@tanstack/react-router";
import { FolderInputIcon, FolderPlusIcon, MilestoneIcon } from "lucide-react";

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
    const destinations = threadFolderChoices(snapshot, owner.id, home)
      .filter((choice) => !choice.checked)
      .map((choice): CommandPaletteActionItem => ({
        kind: "action",
        value: `move-thread-to-folder:${choice.folderId ?? "top"}`,
        searchTerms: choice.folderId === null ? [choice.label, owner.name] : [choice.label],
        title: choice.label,
        icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await commands.moveThread(thread.environmentId, thread.threadId, choice.folderId);
        },
      }));
    if (destinations.length > 0) {
      items.push({
        kind: "submenu",
        value: "action:move-thread-to-folder",
        searchTerms: ["move thread to folder", "file thread", "folder"],
        title: "Move thread to folder…",
        icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "folders",
            label: owner.kind === "personal" ? "Folders" : owner.name,
            items: destinations,
          },
        ],
      });
    }
    const folder = snapshot.folders.find((candidate) => candidate.id === home);
    const phase = folder?.phase;
    if (folder && phase) {
      items.push({
        kind: "submenu",
        value: "action:folder-phase",
        searchTerms: ["folder phase", "phase", "stage", folder.name],
        title: "Move folder to phase…",
        icon: <MilestoneIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <MilestoneIcon className={ADDON_ICON_CLASS} />,
        groups: [
          {
            value: "phases",
            label: folder.name,
            items: phase.phases
              .filter((name) => name !== phase.current)
              .map((name): CommandPaletteActionItem => ({
                kind: "action",
                value: `folder-phase:${name}`,
                searchTerms: [name],
                title: name,
                icon: <MilestoneIcon className={ITEM_ICON_CLASS} />,
                run: async () => {
                  await commands.setPhase(thread.environmentId, { id: folder.id, current: name });
                },
              })),
          },
        ],
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
        searchTerms: [context.name, ownerLevelName(context)],
        title: ownerLevelName(context),
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
