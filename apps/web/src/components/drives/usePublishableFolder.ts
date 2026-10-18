import { useAtomValue } from "@effect/atom-react";
import { driveOfProject } from "@t3tools/client-runtime/state/signalboxDrives";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { canManageDrive, type SignalboxDrive } from "@t3tools/contracts/signalboxDrives";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useProject, useThreadShell } from "../../state/entities";
import { environmentDrivesAtom } from "../../state/signalboxDrives";

export interface PublishableFolder {
  readonly drive: SignalboxDrive;
  /** What `sourceControl.publishRepository` publishes: the folder's root, never a thread's tree. */
  readonly workspaceRoot: string;
}

/**
 * The cloud folder a thread works in, when the user may publish it to GitHub. Only a folder
 * of its own counts (a shared drive or a shared folder); a My Drive holds a whole top level,
 * not one repository. Changing a folder's remote is a manager's call, so other members never
 * see the offer. Callers check that the folder has no remote yet.
 */
export function usePublishableFolder(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId?: DraftId | undefined;
}): PublishableFolder | null {
  const draftProjectId = useComposerDraftStore((store) =>
    input.draftId ? (store.getDraftSession(input.draftId)?.projectId ?? null) : null,
  );
  const shell = useThreadShell(
    input.draftId ? null : { environmentId: input.environmentId, threadId: input.threadId },
  );
  const projectId: ProjectId | null = draftProjectId ?? shell?.projectId ?? null;
  const project = useProject(
    projectId === null ? null : { environmentId: input.environmentId, projectId },
  );
  const drives = useAtomValue(environmentDrivesAtom).get(input.environmentId) ?? null;
  if (project === null) return null;
  const drive = driveOfProject(drives, project.id);
  if (drive === undefined || drive.kind === "my" || !canManageDrive(drive.role)) return null;
  return { drive, workspaceRoot: project.workspaceRoot };
}
