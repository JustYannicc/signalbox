/**
 * The one folder dialog open at a time. The sidebar and the command palette
 * both open it; `FolderDialogs`, mounted once with the app shell, shows it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import type { Folder, FolderLevel } from "@t3tools/contracts/signalboxFolders";
import { create } from "zustand";

export type FolderDialog =
  | {
      readonly kind: "create";
      readonly environmentId: EnvironmentId;
      readonly ownerId: SignalboxContextId;
      /** Where it's made: its parent folder, or the owner's top level. */
      readonly parent: Folder | null;
      readonly ownerName: string;
    }
  | { readonly kind: "rename"; readonly environmentId: EnvironmentId; readonly folder: Folder }
  | {
      readonly kind: "delete";
      readonly environmentId: EnvironmentId;
      readonly folder: Folder;
      /** What deleting it does (`folderDeleteMessage`). */
      readonly message: string;
    }
  | {
      readonly kind: "instructions";
      readonly environmentId: EnvironmentId;
      readonly level: FolderLevel;
      /** The folder's name; null for the top level. */
      readonly name: string | null;
      readonly instructions: string;
    };

/** `shown` stays the last dialog while it closes; `openCount` tells each opening apart. */
export const useFolderDialogStore = create<{
  readonly dialog: FolderDialog | null;
  readonly shown: FolderDialog | null;
  readonly openCount: number;
}>(() => ({ dialog: null, shown: null, openCount: 0 }));

export const openFolderDialog = (dialog: FolderDialog) =>
  useFolderDialogStore.setState((state) => ({
    dialog,
    shown: dialog,
    openCount: state.openCount + 1,
  }));

export const closeFolderDialog = () => useFolderDialogStore.setState({ dialog: null });
