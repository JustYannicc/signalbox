import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

import { filterLevelName, folderPlacement } from "../folders/folder-filter";

/** The thread's home folder, or its owner's top level when it has no folder. */
export function liveActivityFolderLabel(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot,
  thread: Pick<EnvironmentThreadShell, "id" | "projectId">,
): string | null {
  const placement = folderPlacement(snapshot, owners, thread);
  if (placement === null) return null;
  return filterLevelName(
    snapshot,
    owners,
    placement.home === null
      ? { _tag: "top", ownerId: placement.ownerId }
      : { _tag: "folder", folderId: placement.home },
  );
}
