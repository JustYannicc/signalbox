import { useAtomValue } from "@effect/atom-react";
import type { ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import { canManageDrive } from "@t3tools/contracts/signalboxDrives";
import { useState } from "react";

import { signalboxDrives } from "../../state/signalboxDrives";
import { ShareDriveDialog, type FolderShareTarget } from "./ShareDriveDialog";
import { useDriveAtCwd } from "./useDriveAtCwd";

export type DriveFolderShareMenuAction = "share-folder";

export function useDriveFolderShareMenu(environmentId: EnvironmentId, cwd: string) {
  const drive = useDriveAtCwd(environmentId, cwd);
  const canShareFolder = useAtomValue(signalboxDrives.shareFolder.permissionAtom(environmentId));
  const [target, setTarget] = useState<FolderShareTarget | null>(null);
  const myDrive = drive?.kind === "my" ? drive : undefined;

  const shareable =
    canShareFolder && myDrive !== undefined && canManageDrive(myDrive.role) ? myDrive : null;

  /** "Share folder…" for a folder of the user's own My Drive, and nothing else. */
  const buildItems = (
    path: string,
    isDirectory: boolean,
  ): ReadonlyArray<ContextMenuItem<DriveFolderShareMenuAction>> =>
    shareable !== null && isDirectory && path.trim()
      ? [{ id: "share-folder", label: "Share folder…" }]
      : [];

  const activate = (_action: DriveFolderShareMenuAction, path: string) => {
    if (shareable === null || !path.trim()) return;
    setTarget({ myDrive: shareable, path, name: path.split("/").at(-1) ?? path });
  };

  return {
    buildItems,
    activate,
    dialog: target ? (
      <ShareDriveDialog
        environmentId={environmentId}
        drive={null}
        folderShare={target}
        open
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
    ) : null,
  };
}
