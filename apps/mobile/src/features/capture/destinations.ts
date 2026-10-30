import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import { captureDestinations } from "@t3tools/client-runtime/capture/destinations";

import { folderStart, type FolderStart } from "../folders/folder-filter";
import type { FolderEnvironment } from "../../state/signalboxFolders";

export interface CaptureTarget {
  readonly destination: CaptureDestination;
  readonly start: FolderStart;
  readonly ownerKind: SignalboxContext["kind"];
  readonly isPersonalTopLevel: boolean;
}

export function resolveCaptureTargetSelection(
  targets: ReadonlyArray<CaptureTarget>,
  initialPersonalDestinationKey: string | null,
  selectedDestinationKey: string | null,
): CaptureTarget | null {
  const key = selectedDestinationKey ?? initialPersonalDestinationKey;
  return key ? (targets.find((target) => target.destination.key === key) ?? null) : null;
}

export function resolveCaptureTargets(
  environments: ReadonlyMap<EnvironmentId, FolderEnvironment>,
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
): { readonly targets: ReadonlyArray<CaptureTarget>; readonly personal: CaptureTarget | null } {
  const trees = [...environments].map(([environmentId, entry]) => ({
    environmentId,
    snapshot: entry.snapshot,
    contexts: entry.owners,
  }));
  const availableProjects = new Map<EnvironmentId, ReadonlySet<ProjectId>>();
  for (const project of projects) {
    const ids = availableProjects.get(project.environmentId) ?? new Set<ProjectId>();
    availableProjects.set(project.environmentId, new Set([...ids, project.id]));
  }

  const targets = captureDestinations(trees).flatMap((destination) => {
    const tree = trees.find((candidate) => candidate.environmentId === destination.environmentId);
    if (!tree) return [];
    const folderOwnerId = destination.folderId
      ? tree.snapshot.folders.find((folder) => folder.id === destination.folderId)?.ownerId
      : undefined;
    const owner = tree.contexts.contexts.find((context) =>
      folderOwnerId !== undefined
        ? context.id === folderOwnerId
        : destination.key === `${destination.environmentId}:${context.id}:top`,
    );
    if (!owner) return [];
    const level = destination.folderId
      ? { _tag: "folder" as const, folderId: destination.folderId }
      : { _tag: "top" as const, ownerId: owner.id };
    const start = folderStart(tree.snapshot, tree.contexts, destination.environmentId, level);
    if (!start || !availableProjects.get(start.environmentId)?.has(start.projectId)) return [];
    return [
      {
        destination,
        start,
        ownerKind: owner.kind,
        isPersonalTopLevel: owner.kind === "personal" && destination.folderId === null,
      },
    ];
  });

  const preferredEnvironmentId = projects[0]?.environmentId;
  const personal =
    targets.find(
      (target) =>
        target.isPersonalTopLevel && target.destination.environmentId === preferredEnvironmentId,
    ) ??
    targets.find((target) => target.isPersonalTopLevel) ??
    null;
  return { targets, personal };
}
