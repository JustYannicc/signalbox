/**
 * signalbox: the thread list filtered to one folder, or to an owner's top
 * level, on Signalbox Cloud. A thread shows in the folder that is its home
 * (`homeOfThread`), never in the folders above it.
 */
import { contextIdOfProject } from "@t3tools/client-runtime/state/signalboxContexts";
import { newThreadIn } from "@t3tools/client-runtime/state/signalboxFolders";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type { SignalboxContextsSnapshot } from "@t3tools/contracts/signalboxContexts";

/** A level of one owner's tree: its top level, or one of its folders. */
export type FolderLevelRef =
  | { readonly _tag: "top"; readonly ownerId: string }
  | { readonly _tag: "folder"; readonly folderId: FolderId };

const PREFIX = "folder:";

/** The thread list's filter key for a level, kept beside `section-project:` keys. */
export function folderFilterKey(environmentId: EnvironmentId, level: FolderLevelRef): string {
  const target =
    level._tag === "top"
      ? `top:${encodeURIComponent(level.ownerId)}`
      : `in:${encodeURIComponent(level.folderId)}`;
  return `${PREFIX}${encodeURIComponent(environmentId)}:${target}`;
}

export function parseFolderFilterKey(
  key: string | null,
): { readonly environmentId: EnvironmentId; readonly level: FolderLevelRef } | null {
  if (key === null || !key.startsWith(PREFIX)) return null;
  const [environment, kind, id, ...rest] = key.slice(PREFIX.length).split(":");
  if (!environment || !id || rest.length > 0) return null;
  const environmentId = decodeURIComponent(environment) as EnvironmentId;
  const value = decodeURIComponent(id);
  if (kind === "top") return { environmentId, level: { _tag: "top", ownerId: value } };
  if (kind === "in")
    return { environmentId, level: { _tag: "folder", folderId: value as FolderId } };
  return null;
}

/** The thread list's filter choices with the shown folder among them, so it stays selected. */
export function withFolderFilterOption<
  Option extends { readonly key: string; readonly label: string },
>(
  options: ReadonlyArray<Option>,
  folder: { readonly key: string; readonly label: string } | null,
): ReadonlyArray<Option | { readonly key: string; readonly label: string }> {
  if (folder === null || options.some((option) => option.key === folder.key)) return options;
  return [...options, { key: folder.key, label: folder.label }];
}

/** Something that lives in a folder: a thread, or a task that isn't one yet (no id). */
export interface FolderResident {
  readonly id?: ThreadId | null;
  readonly projectId: ProjectId;
}

/**
 * Where residents live and whose they are. The owner is the home folder's,
 * else the owner of the resident's project.
 */
export function folderResidency(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot | null,
) {
  const filed = new Map(snapshot.threadHomes.map((home) => [home.threadId, home.folderId]));
  const byProject = new Map(snapshot.projectHomes.map((home) => [home.projectId, home.folderId]));
  const ownerOfFolder = new Map(snapshot.folders.map((folder) => [folder.id, folder.ownerId]));
  const homeOf = (resident: FolderResident): FolderId | null =>
    resident.id != null && filed.has(resident.id)
      ? (filed.get(resident.id) ?? null)
      : (byProject.get(resident.projectId) ?? null);
  const ownerOf = (resident: FolderResident, home: FolderId | null): string | undefined =>
    (home === null ? undefined : ownerOfFolder.get(home)) ??
    contextIdOfProject(owners, resident.projectId);
  return {
    homeOf,
    ownerOf: (resident: FolderResident) => ownerOf(resident, homeOf(resident)),
    /** Whether `resident` lives right at `level`. */
    isAt: (level: FolderLevelRef, resident: FolderResident): boolean => {
      const home = homeOf(resident);
      return level._tag === "folder"
        ? home === level.folderId
        : home === null && ownerOf(resident, home) === level.ownerId;
    },
  };
}

/** How many residents live right at each level: by folder, and at each owner's top level. */
export function folderResidentCounts(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot | null,
  residents: ReadonlyArray<FolderResident>,
) {
  const residency = folderResidency(snapshot, owners);
  const folders = new Map<FolderId, number>();
  const top = new Map<string, number>();
  for (const resident of residents) {
    const home = residency.homeOf(resident);
    if (home !== null) {
      folders.set(home, (folders.get(home) ?? 0) + 1);
      continue;
    }
    const owner = residency.ownerOf(resident);
    if (owner !== undefined) top.set(owner, (top.get(owner) ?? 0) + 1);
  }
  return { folders, top };
}

/** Where a new task shown at a level starts, and the folder it's filed in. */
export interface FolderStart {
  readonly environmentId: EnvironmentId;
  /** Null: the owner's top level. */
  readonly folderId: FolderId | null;
  readonly name: string;
  readonly projectId: ProjectId;
  /** Its project's threads live elsewhere, so the new thread has to be filed here. */
  readonly file: boolean;
}

/**
 * A new task at `level` works in the folder's files, else its owner's own
 * (the first of the owner's projects). Null while either isn't known.
 */
export function folderStart(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot | null,
  environmentId: EnvironmentId,
  level: FolderLevelRef,
): FolderStart | null {
  const folder =
    level._tag === "folder"
      ? snapshot.folders.find((candidate) => candidate.id === level.folderId)
      : undefined;
  if (level._tag === "folder" && folder === undefined) return null;
  const ownerId = folder?.ownerId ?? (level._tag === "top" ? level.ownerId : undefined);
  const owner = owners?.contexts.find((candidate) => candidate.id === ownerId);
  const ownerProjectId = owner?.projectIds[0];
  if (owner === undefined || ownerProjectId === undefined) return null;
  const { projectId, file } = newThreadIn(snapshot, folder?.id ?? null, ownerProjectId);
  return {
    environmentId,
    folderId: folder?.id ?? null,
    name: folder?.name ?? owner.name,
    projectId,
    file,
  };
}

/** A level's name: the folder's, or its owner's for the top level. */
export function folderLevelName(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot | null,
  level: FolderLevelRef,
): string | null {
  if (level._tag === "folder") {
    return snapshot.folders.find((folder) => folder.id === level.folderId)?.name ?? null;
  }
  return owners?.contexts.find((owner) => owner.id === level.ownerId)?.name ?? null;
}
