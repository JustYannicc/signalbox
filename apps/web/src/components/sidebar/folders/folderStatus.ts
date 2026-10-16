/**
 * signalbox: folder status roll-ups (#670) for the sidebar tree. The counting
 * itself is `folderStatusRollups` in client-runtime; this keys it by folder
 * node across environments and keeps unchanged folders' counts, so only a
 * folder whose numbers moved redraws.
 */
import {
  folderStatusRollups,
  type FolderStatusCounts,
  type StatusResident,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

import { folderNodeKey, sameEntries, type FolderOwner } from "./folderSidebarModel";

export type FolderStatusResident = StatusResident & { readonly environmentId: EnvironmentId };

/**
 * Every folder's counts by state, by folder node key. Like the folder thread
 * counts, only threads of the tree's owners count. Counts equal to the
 * previous ones keep their object, and with nothing changed the previous map
 * comes back.
 */
export function folderStatusCountsByNode(
  trees: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: SignalboxFoldersSnapshot;
    readonly owners: ReadonlyArray<FolderOwner>;
  }>,
  residents: ReadonlyArray<FolderStatusResident>,
  previous: ReadonlyMap<string, FolderStatusCounts> | undefined,
): ReadonlyMap<string, FolderStatusCounts> {
  const next = new Map<string, FolderStatusCounts>();
  for (const tree of trees) {
    const owned = new Set(tree.owners.flatMap((owner) => owner.context.projectIds));
    const rollups = folderStatusRollups(
      tree.snapshot,
      residents.filter(
        (thread) => thread.environmentId === tree.environmentId && owned.has(thread.projectId),
      ),
    );
    for (const [folderId, rollup] of rollups) {
      const key = folderNodeKey(tree.environmentId, folderId);
      const kept = previous?.get(key);
      next.set(key, kept !== undefined && sameCounts(kept, rollup.counts) ? kept : rollup.counts);
    }
  }
  return previous !== undefined && sameEntries(previous, next) ? previous : next;
}

const sameCounts = (left: FolderStatusCounts, right: FolderStatusCounts) =>
  left.working === right.working && left.waiting === right.waiting && left.idle === right.idle;

/** The full breakdown, idle included, for the folder's tooltip: "2 working · 1 waiting · 4 idle". */
export function folderStatusBreakdown(counts: FolderStatusCounts): string {
  return [
    counts.working > 0 ? `${counts.working} working` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
    counts.idle > 0 ? `${counts.idle} idle` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
