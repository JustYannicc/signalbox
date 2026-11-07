import type { DesktopCaptureOwner } from "@t3tools/contracts";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import type { EnvironmentId } from "@t3tools/contracts";

export function captureFolderSnapshotsResolved(
  folders: ReadonlyMap<EnvironmentId, { readonly snapshot: unknown | null }>,
  contexts: ReadonlyMap<EnvironmentId, unknown>,
): boolean {
  if (folders.size === 0) return false;
  for (const [environmentId, folder] of folders) {
    if (folder.snapshot === null || !contexts.has(environmentId)) return false;
  }
  return true;
}

export function captureOwnerIsAvailable(
  owner: DesktopCaptureOwner | undefined,
  destinations: ReadonlyArray<CaptureDestination>,
): boolean {
  return (
    owner !== undefined &&
    destinations.some(
      (destination) =>
        destination.environmentId === owner.environmentId &&
        destination.ownerProjectId === owner.ownerProjectId,
    )
  );
}
