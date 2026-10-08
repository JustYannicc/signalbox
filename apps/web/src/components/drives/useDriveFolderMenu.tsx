import type { ContextMenuItem, EnvironmentId } from "@t3tools/contracts";

import {
  type DriveFolderShareMenuAction,
  useDriveFolderShareMenu,
} from "./useDriveFolderShareMenu";
import { type DriveShortcutMenuAction, useDriveShortcutsMenu } from "./useDriveShortcutsMenu";

type DriveFolderMenuAction = DriveFolderShareMenuAction | DriveShortcutMenuAction;

const ACTIONS: ReadonlySet<string> = new Set<DriveFolderMenuAction>([
  "share-folder",
  "add-shortcut",
  "remove-shortcut",
]);

/** The drive entries of a Files panel's folder menu: sharing and shortcuts. */
export function useDriveFolderMenu(
  environmentId: EnvironmentId,
  cwd: string,
  onFilesChanged: () => void,
) {
  const share = useDriveFolderShareMenu(environmentId, cwd);
  const shortcuts = useDriveShortcutsMenu(environmentId, cwd, onFilesChanged);

  const buildItems = (
    path: string,
    isDirectory: boolean,
  ): ReadonlyArray<ContextMenuItem<DriveFolderMenuAction>> => [
    // A shortcut shows another drive, which is shared from there.
    ...(shortcuts.inShortcut(path) ? [] : share.buildItems(path, isDirectory)),
    ...shortcuts.buildItems(path, isDirectory),
  ];

  const handles = (id: string): id is DriveFolderMenuAction => ACTIONS.has(id);

  const activate = (action: DriveFolderMenuAction, path: string) => {
    if (action === "share-folder") share.activate(action, path);
    else shortcuts.activate(action, path);
  };

  return {
    buildItems,
    handles,
    activate,
    toolbarButton: shortcuts.toolbarButton,
    dialog: (
      <>
        {share.dialog}
        {shortcuts.dialog}
      </>
    ),
  };
}
