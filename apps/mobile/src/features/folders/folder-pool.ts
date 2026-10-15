/**
 * signalbox: the pool a thread or new task runs on where Signalbox Cloud
 * keeps folders: its home folder's, the nearest pool on that folder's chain
 * (`poolOfTarget`).
 */
import { folderLevelName, poolOfTarget } from "@t3tools/client-runtime/state/signalboxFolders";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  FolderId,
  FolderResolvedPool,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

/** What a pool is resolved for: an existing thread, or a new one started in a folder. */
export type PoolHome = { readonly threadId: ThreadId } | { readonly folderId: FolderId | null };

/** The pool `projectId`'s thread, or a new one at `home`, runs on. */
export function poolOfPoolHome(
  snapshot: SignalboxFoldersSnapshot,
  projectId: ProjectId | null,
  home: PoolHome | undefined,
): FolderResolvedPool | null {
  return poolOfTarget(snapshot, { projectId, ...home });
}

/** "Runs on Work · from Clients", or "· from the top level" when that's where its pool is placed. */
export function folderPoolSourceLabel(
  snapshot: SignalboxFoldersSnapshot,
  pool: FolderResolvedPool | null,
  poolName: string | undefined,
): string {
  if (pool === null) return "Needs a pool";
  const name = poolName ?? "its pool";
  const from = folderLevelName(snapshot, pool.from);
  return from === null ? `Runs on ${name}` : `Runs on ${name} · from ${from}`;
}
