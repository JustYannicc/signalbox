import { driveOfProject } from "@t3tools/client-runtime/state/signalboxDrives";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  canManageDrive,
  type SignalboxDrive,
  type SignalboxDrivesSnapshot,
} from "@t3tools/contracts/signalboxDrives";

import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentDrives } from "../../state/signalboxDrives";

export interface PublishableFolder {
  readonly drive: SignalboxDrive;
  /** What `sourceControl.publishRepository` publishes: the folder's root, never a thread's tree. */
  readonly workspaceRoot: string;
}

/**
 * The drive behind `projectId` when the user may publish it to GitHub. Only a folder of its own
 * counts (a shared drive or a shared folder); a My Drive holds a whole top level, not one
 * repository. Changing a folder's remote is a manager's call, so other members never see the
 * offer. Callers check that the folder has no remote yet.
 */
export function publishableDrive(
  drives: SignalboxDrivesSnapshot | null,
  projectId: ProjectId,
): SignalboxDrive | null {
  const drive = driveOfProject(drives, projectId);
  return drive === undefined || drive.kind === "my" || !canManageDrive(drive.role) ? null : drive;
}

export function usePublishableProject(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): PublishableFolder | null {
  const project = useProject(
    environmentId !== null && projectId !== null ? { environmentId, projectId } : null,
  );
  const drives = useEnvironmentDrives(environmentId);
  const drive = project === null ? null : publishableDrive(drives, project.id);
  return drive === null || project === null
    ? null
    : { drive, workspaceRoot: project.workspaceRoot };
}

/** The publishable folder a thread works in. */
export function usePublishableFolder(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): PublishableFolder | null {
  const shell = useThreadShell(
    environmentId !== null && threadId !== null ? { environmentId, threadId } : null,
  );
  return usePublishableProject(environmentId, shell?.projectId ?? null);
}
