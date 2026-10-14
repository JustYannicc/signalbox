/**
 * signalbox: the pool a thread or new task runs on where Signalbox Cloud
 * keeps folders: its home folder's, the nearest pool on that folder's chain.
 */
import { homeOfThread, poolOfHome } from "@t3tools/client-runtime/state/signalboxFolders";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SectionsSnapshot } from "@t3tools/contracts/sections";
import type {
  FolderId,
  FolderResolvedPool,
  SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";

/** What a pool is resolved for: an existing thread, or a new one started in a folder. */
export type PoolHome = { readonly threadId: ThreadId } | { readonly folderId: FolderId | null };

/** The folder the target lives in: the given folder, the thread's home, else its project's. */
export function folderHomeOf(
  snapshot: SignalboxFoldersSnapshot,
  projectId: ProjectId | null,
  home: PoolHome | undefined,
): FolderId | null {
  if (home !== undefined && "folderId" in home) return home.folderId;
  if (projectId === null) return null;
  if (home !== undefined) return homeOfThread(snapshot, { id: home.threadId, projectId });
  return snapshot.projectHomes.find((entry) => entry.projectId === projectId)?.folderId ?? null;
}

/** The pool `home`'s threads run on: null when nothing on its chain has one. */
export function folderPoolOf(
  snapshot: SignalboxFoldersSnapshot,
  projectId: ProjectId | null,
  home: PoolHome | undefined,
): FolderResolvedPool | null {
  return poolOfHome(snapshot, folderHomeOf(snapshot, projectId, home));
}

/**
 * A sections snapshot whose top level runs on `pool`. The shared pool helpers
 * (`projectPool`, `projectPoolModelSelection`, `poolNeed`) read pools from
 * one and only use the pool's id, so reading it with no project gives `pool`.
 */
export function poolSnapshotFor(pool: FolderResolvedPool | null): SectionsSnapshot {
  return {
    revision: 0,
    sections: [],
    projectPlacements: [],
    pools: {
      top: pool === null ? null : { poolId: pool.poolId, from: { _tag: "top" } },
      sections: [],
      projects: [],
    },
  };
}

/** "Runs on Work · from Clients", or "· from the top level" when that's where its pool is placed. */
export function folderPoolSourceLabel(
  snapshot: SignalboxFoldersSnapshot,
  pool: FolderResolvedPool | null,
  poolName: string | undefined,
): string {
  if (pool === null) return "Needs a pool";
  const name = poolName ?? "its pool";
  const level = pool.from;
  if (level._tag === "top") return `Runs on ${name} · from the top level`;
  const folder = snapshot.folders.find((candidate) => candidate.id === level.folderId);
  return folder ? `Runs on ${name} · from ${folder.name}` : `Runs on ${name}`;
}
