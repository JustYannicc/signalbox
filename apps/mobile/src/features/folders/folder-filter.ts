/**
 * signalbox: the thread list filtered to one folder, or to an owner's top
 * level, on Signalbox Cloud. A thread shows in the folder that is its home
 * (`threadHomeLookup`), never in the folders above it.
 */
import {
  homeOfProject,
  newThreadIn,
  ownerFilesProject,
  ownerLevelName,
  threadHomeLookup,
} from "@t3tools/client-runtime/state/signalboxFolders";
import { EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import {
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import * as Schema from "effect/Schema";

/** A level of one owner's tree: its top level, or one of its folders. */
export type FolderLevelRef =
  | { readonly _tag: "top"; readonly ownerId: SignalboxContextId }
  | { readonly _tag: "folder"; readonly folderId: FolderId };

const PREFIX = "folder:";
const isEnvironmentId = Schema.is(EnvironmentId);
const isOwnerId = Schema.is(SignalboxContextId);
const isFolderId = Schema.is(FolderId);

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
  if (environment === undefined || id === undefined || rest.length > 0) return null;
  const environmentId = decodeURIComponent(environment);
  const value = decodeURIComponent(id);
  if (!isEnvironmentId(environmentId)) return null;
  if (kind === "top" && isOwnerId(value)) {
    return { environmentId, level: { _tag: "top", ownerId: value } };
  }
  if (kind === "in" && isFolderId(value)) {
    return { environmentId, level: { _tag: "folder", folderId: value } };
  }
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

/** Where a thread lives and whose it is. */
export interface FolderPlacement {
  readonly ownerId: SignalboxContextId;
  readonly home: FolderId | null;
}

const ownersByProject = new WeakMap<
  SignalboxContextsSnapshot,
  ReadonlyMap<ProjectId, SignalboxContextId>
>();

/** The owner whose files `projectId` is, cached per owners snapshot. */
function ownerOfProject(
  owners: SignalboxContextsSnapshot,
  projectId: ProjectId,
): SignalboxContextId | undefined {
  let byProject = ownersByProject.get(owners);
  if (byProject === undefined) {
    byProject = new Map(
      owners.contexts.flatMap((owner) =>
        owner.projectIds.map((ownedProject) => [ownedProject, owner.id] as const),
      ),
    );
    ownersByProject.set(owners, byProject);
  }
  return byProject.get(projectId);
}

/**
 * Where `resident` lives and whose it is: its home folder's owner, else its
 * project's. Null when neither is known.
 */
export function folderPlacement(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot,
  resident: FolderResident,
): FolderPlacement | null {
  const home =
    resident.id == null
      ? homeOfProject(snapshot, resident.projectId)
      : threadHomeLookup(snapshot)({ id: resident.id, projectId: resident.projectId });
  const ownerId =
    (home === null ? undefined : ownerOfFolder(snapshot, home)) ??
    ownerOfProject(owners, resident.projectId);
  return ownerId === undefined ? null : { ownerId, home };
}

const ownersByFolder = new WeakMap<
  SignalboxFoldersSnapshot,
  ReadonlyMap<FolderId, SignalboxContextId>
>();

/** Whose tree `folderId` is in, cached per folders snapshot. */
function ownerOfFolder(
  snapshot: SignalboxFoldersSnapshot,
  folderId: FolderId,
): SignalboxContextId | undefined {
  let byFolder = ownersByFolder.get(snapshot);
  if (byFolder === undefined) {
    byFolder = new Map(snapshot.folders.map((folder) => [folder.id, folder.ownerId] as const));
    ownersByFolder.set(snapshot, byFolder);
  }
  return byFolder.get(folderId);
}

/** Whether `resident` lives right at `level`. */
export function isAtLevel(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot,
  level: FolderLevelRef,
  resident: FolderResident,
): boolean {
  const placement = folderPlacement(snapshot, owners, resident);
  if (placement === null) return false;
  return level._tag === "folder"
    ? placement.home === level.folderId
    : placement.home === null && placement.ownerId === level.ownerId;
}

/** The threads folder counts include: those of the environment's owners' projects. */
export function ownedResidents<Resident extends FolderResident>(
  owners: SignalboxContextsSnapshot,
  residents: ReadonlyArray<Resident>,
): ReadonlyArray<Resident> {
  return residents.filter((resident) => ownerOfProject(owners, resident.projectId) !== undefined);
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
  /** Where it lands when it can't be filed: its project's home. */
  readonly unfiledName: string;
}

/**
 * A new task at `level` works in the folder's files, else its owner's own
 * (`ownerFilesProject`). Null while either isn't known.
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
  const ownerProjectId = owner === undefined ? null : ownerFilesProject(owner);
  if (owner === undefined || ownerProjectId === null) return null;
  const { projectId, file } = newThreadIn(snapshot, folder?.id ?? null, ownerProjectId);
  const projectHome = homeOfProject(snapshot, projectId);
  return {
    environmentId,
    folderId: folder?.id ?? null,
    name: folder?.name ?? ownerLevelName(owner),
    projectId,
    file,
    unfiledName:
      snapshot.folders.find((candidate) => candidate.id === projectHome)?.name ??
      (owner.kind === "personal" ? "the top level" : `the top level of ${owner.name}`),
  };
}

/** What the filter calls a level: the folder's name, or its owner's for the top level. */
export function filterLevelName(
  snapshot: SignalboxFoldersSnapshot,
  owners: SignalboxContextsSnapshot | null,
  level: FolderLevelRef,
): string | null {
  if (level._tag === "folder") {
    return snapshot.folders.find((folder) => folder.id === level.folderId)?.name ?? null;
  }
  const owner = owners?.contexts.find((candidate) => candidate.id === level.ownerId);
  return owner ? ownerLevelName(owner) : null;
}
