/**
 * Where a capture can go: your own top level (where an untagged capture
 * lands, like Todoist's Inbox), each organization's top level, then every
 * folder in tree order.
 */
import {
  folderDestinations,
  inOwnerLevel,
  ownerLevelName,
} from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { FolderId } from "@t3tools/contracts/signalboxFolders";

import type { FolderEnvironmentTree } from "../sidebar/folders/folderThreads";

export interface CaptureDestination {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  /** Null: the owner's top level. */
  readonly folderId: FolderId | null;
  readonly ownerProjectId: ProjectId;
  /** "Work / Clients"; "Top level" for your own, the organization's name for its. */
  readonly label: string;
  /** The organization a folder belongs to, when you're in more than one place. */
  readonly detail: string | null;
  /** In a sentence: "at the top level", "in Acme", "in Work / Clients". */
  readonly inPlace: string;
}

export function captureDestinations(
  trees: Iterable<FolderEnvironmentTree>,
): ReadonlyArray<CaptureDestination> {
  const tops: CaptureDestination[] = [];
  const folders: CaptureDestination[] = [];
  for (const tree of trees) {
    const several = tree.owners.length > 1;
    for (const owner of tree.owners) {
      if (owner.filesProjectId === null) continue;
      const ownerProjectId = owner.filesProjectId;
      const detail = several && owner.context.kind !== "personal" ? owner.context.name : null;
      tops.push({
        key: `${tree.environmentId}:${owner.context.id}:top`,
        environmentId: tree.environmentId,
        folderId: null,
        ownerProjectId,
        label: ownerLevelName(owner.context),
        detail: null,
        inPlace: inOwnerLevel(owner.context),
      });
      for (const destination of folderDestinations(tree.snapshot, owner.context.id)) {
        folders.push({
          key: `${tree.environmentId}:${destination.folder.id}`,
          environmentId: tree.environmentId,
          folderId: destination.folder.id,
          ownerProjectId,
          label: destination.label,
          detail,
          inPlace: `in ${destination.label}`,
        });
      }
    }
  }
  return [...tops, ...folders];
}
