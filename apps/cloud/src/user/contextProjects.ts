import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";

import { myDriveId, parseDriveId } from "../drive/driveAccess.ts";
import * as Environment from "../environment.ts";
import type { IndexedDrive } from "./UserDriveIndex.ts";

/**
 * Every drive a user can open is a project in their shell, listed under its
 * context; a thread started in one works in that drive and acts as that
 * context. Each context's own project is the user's My Drive there: Personal
 * is Scratch, the "No project" every new thread starts in, and a work
 * organization's is named after it. Shared drives and folders shared with the
 * user are `drive:<drive id>`.
 *
 * Both ids and workspace roots name their drive, so mapping one to the other
 * needs no lookup; whether the user may open it is a separate question.
 */

const ORGANIZATION_PROJECT_PREFIX = "context:";
const DRIVE_PROJECT_PREFIX = "drive:";
const DRIVE_ROOT_PREFIX = "/drives/";
const CONTEXT_ROOT_PREFIX = "/contexts/";

export const projectIdForContext = (contextId: SignalboxContextId): ProjectId =>
  contextId === PERSONAL_CONTEXT_ID
    ? Environment.SCRATCH_PROJECT_ID
    : ProjectId.make(`${ORGANIZATION_PROJECT_PREFIX}${contextId}`);

export const projectIdForDrive = (driveId: string): ProjectId =>
  ProjectId.make(`${DRIVE_PROJECT_PREFIX}${driveId}`);

/** A context's projects: the user's My Drive there, then the drives others gave them in it. */
export const contextProjectIds = (
  contextId: SignalboxContextId,
  drives: ReadonlyArray<IndexedDrive>,
): ReadonlyArray<ProjectId> => [
  projectIdForContext(contextId),
  ...drives
    .filter((drive) => parseDriveId(drive.driveId)?.contextId === contextId)
    .map((drive) => projectIdForDrive(drive.driveId)),
];

/** The context a thread in `projectId` acts as, or null when it's none of `contexts`. */
export const contextOfProject = (
  contexts: ReadonlyArray<SignalboxContext>,
  projectId: ProjectId,
): SignalboxContextId | null =>
  contexts.find((context) => context.projectIds.includes(projectId))?.id ?? null;

/** The drive `projectId` names for `userId`, or null when it names none. */
export const driveOfProject = (projectId: ProjectId, userId: string): string | null => {
  if (projectId.startsWith(DRIVE_PROJECT_PREFIX)) {
    const driveId = projectId.slice(DRIVE_PROJECT_PREFIX.length);
    return parseDriveId(driveId) === null ? null : driveId;
  }
  if (projectId === Environment.SCRATCH_PROJECT_ID) return myDriveId(PERSONAL_CONTEXT_ID, userId);
  if (projectId.startsWith(ORGANIZATION_PROJECT_PREFIX)) {
    const contextId = projectId.slice(ORGANIZATION_PROJECT_PREFIX.length);
    return contextId === "" ? null : myDriveId(SignalboxContextId.make(contextId), userId);
  }
  return null;
};

/** The drive a project's workspace root names for `userId`, or null when it names none. */
export const driveOfRoot = (cwd: string, userId: string): string | null => {
  if (cwd.startsWith(DRIVE_ROOT_PREFIX)) {
    const driveId = cwd.slice(DRIVE_ROOT_PREFIX.length);
    return parseDriveId(driveId) === null ? null : driveId;
  }
  if (cwd === Environment.scratchProject.workspaceRoot) {
    return myDriveId(PERSONAL_CONTEXT_ID, userId);
  }
  if (cwd.startsWith(CONTEXT_ROOT_PREFIX)) {
    const contextId = cwd.slice(CONTEXT_ROOT_PREFIX.length);
    return contextId === "" ? null : myDriveId(SignalboxContextId.make(contextId), userId);
  }
  return null;
};

/** The sidebar's projects: each context's, in the contexts' order. */
export const contextProjects = (
  contexts: ReadonlyArray<SignalboxContext>,
  drives: ReadonlyArray<IndexedDrive>,
): ReadonlyArray<OrchestrationProjectShell> =>
  contexts.flatMap((context) => [
    context.kind === "personal"
      ? Environment.scratchProject
      : {
          ...Environment.scratchProject,
          id: projectIdForContext(context.id),
          title: context.name,
          workspaceRoot: `${CONTEXT_ROOT_PREFIX}${context.id}`,
        },
    ...drives
      .filter((drive) => parseDriveId(drive.driveId)?.contextId === context.id)
      .map((drive) => ({
        ...Environment.scratchProject,
        id: projectIdForDrive(drive.driveId),
        title: drive.name,
        workspaceRoot: `${DRIVE_ROOT_PREFIX}${drive.driveId}`,
      })),
  ]);
