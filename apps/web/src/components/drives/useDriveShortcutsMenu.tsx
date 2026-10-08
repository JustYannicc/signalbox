import { useAtomValue } from "@effect/atom-react";
import type { ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import {
  canWriteDrive,
  type SignalboxDrive,
  type SignalboxDriveShortcut,
} from "@t3tools/contracts/signalboxDrives";
import { FolderSymlinkIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { signalboxDrives } from "../../state/signalboxDrives";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddDriveShortcutDialog } from "./AddDriveShortcutDialog";
import { RemoveDriveShortcutDialog } from "./RemoveDriveShortcutDialog";
import { useDriveAtCwd } from "./useDriveAtCwd";

export type DriveShortcutMenuAction = "add-shortcut" | "remove-shortcut";

type Pending =
  | { readonly kind: "add"; readonly parentPath: string }
  | { readonly kind: "remove"; readonly shortcut: SignalboxDriveShortcut };

/**
 * Shortcuts in the Files panel of a drive the user can change: "Add shortcut
 * here…" on folders and a toolbar button for the root, "Remove shortcut" on
 * a shortcut's folder. Nothing outside Signalbox Cloud drives.
 */
export function useDriveShortcutsMenu(
  environmentId: EnvironmentId,
  cwd: string,
  onFilesChanged: () => void,
) {
  const drive = useDriveAtCwd(environmentId, cwd);
  const canAdd = useAtomValue(signalboxDrives.addShortcut.permissionAtom(environmentId));
  const canRemove = useAtomValue(signalboxDrives.removeShortcut.permissionAtom(environmentId));
  const listShortcuts = useAtomCommand(signalboxDrives.shortcuts, { reportFailure: false });
  const [pending, setPending] = useState<Pending | null>(null);
  const writable = drive !== undefined && canWriteDrive(drive.role) ? drive : null;
  const driveId = writable?.id ?? null;

  // By drive, so a late answer for a drive the panel left never shows here.
  const [loaded, setLoaded] = useState<
    Readonly<Record<string, ReadonlyArray<SignalboxDriveShortcut>>>
  >({});
  const shortcuts = (driveId === null ? undefined : loaded[driveId]) ?? [];
  const load = useCallback(
    (id: SignalboxDrive["id"]) =>
      listShortcuts({ environmentId, input: { driveId: id } }).then((result) => {
        if (result._tag === "Success") {
          setLoaded((current) => ({ ...current, [id]: result.value.shortcuts }));
        }
      }),
    [environmentId, listShortcuts],
  );

  useEffect(() => {
    if (driveId !== null) void load(driveId);
  }, [driveId, load]);

  /** Whether `path` is a shortcut's folder or inside one; those are read-only. */
  const inShortcut = (path: string) =>
    shortcuts.some((shortcut) => path === shortcut.path || path.startsWith(`${shortcut.path}/`));

  const buildItems = (
    path: string,
    isDirectory: boolean,
  ): ReadonlyArray<ContextMenuItem<DriveShortcutMenuAction>> => {
    if (writable === null || !isDirectory || !path.trim()) return [];
    if (shortcuts.some((shortcut) => shortcut.path === path))
      return canRemove ? [{ id: "remove-shortcut", label: "Remove shortcut" }] : [];
    return canAdd && !inShortcut(path) ? [{ id: "add-shortcut", label: "Add shortcut here…" }] : [];
  };

  const activate = (action: DriveShortcutMenuAction, path: string) => {
    if (writable === null) return;
    if (action === "add-shortcut") {
      setPending({ kind: "add", parentPath: path });
      return;
    }
    const shortcut = shortcuts.find((candidate) => candidate.path === path);
    if (shortcut !== undefined) setPending({ kind: "remove", shortcut });
  };

  const changed = () => {
    if (driveId !== null) void load(driveId);
    onFilesChanged();
  };
  const close = (open: boolean) => {
    if (!open) setPending(null);
  };

  return {
    inShortcut,
    buildItems,
    activate,
    /** Adds a shortcut at the drive's root. */
    toolbarButton:
      writable !== null && canAdd ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Add shortcut"
                onClick={() => setPending({ kind: "add", parentPath: "" })}
              />
            }
          >
            <FolderSymlinkIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Add shortcut</TooltipPopup>
        </Tooltip>
      ) : null,
    dialog:
      writable === null || pending === null ? null : pending.kind === "add" ? (
        <AddDriveShortcutDialog
          environmentId={environmentId}
          drive={writable}
          parentPath={pending.parentPath}
          onAdded={changed}
          onOpenChange={close}
        />
      ) : (
        <RemoveDriveShortcutDialog
          environmentId={environmentId}
          drive={writable}
          shortcut={pending.shortcut}
          onRemoved={changed}
          onOpenChange={close}
        />
      ),
  };
}
