import { type OrchestrationProjectShell, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";

import { myDriveId, parseDriveId } from "../drive/driveAccess.ts";
import * as Environment from "../environment.ts";
import type { ThreadWorktree } from "../thread/threadDecider.ts";
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

/** A drive's root, as its project's workspace root. */
export const driveRoot = (driveId: string) => `${DRIVE_ROOT_PREFIX}${driveId}`;

const THREADS_SEGMENT = "/threads/";

/**
 * A thread's own branch on its drive's remote (#135), and the path clients
 * address its working tree by. The branch name only has to be stable and
 * unlikely to collide within one repository.
 */
export const remoteThreadWorktree = (driveId: string, threadId: ThreadId): ThreadWorktree => ({
  branch: `signalbox/${threadId
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(-8)
    .toLowerCase()}`,
  path: `${driveRoot(driveId)}${THREADS_SEGMENT}${threadId}`,
});

/** The drive and thread a working tree from `remoteThreadWorktree` names, or null for any other path. */
export const threadWorktreeAt = (
  cwd: string,
): { readonly driveId: string; readonly threadId: ThreadId } | null => {
  if (!cwd.startsWith(DRIVE_ROOT_PREFIX)) return null;
  const at = cwd.indexOf(THREADS_SEGMENT, DRIVE_ROOT_PREFIX.length);
  if (at === -1) return null;
  const driveId = cwd.slice(DRIVE_ROOT_PREFIX.length, at);
  const threadId = cwd.slice(at + THREADS_SEGMENT.length);
  return parseDriveId(driveId) === null || threadId === ""
    ? null
    : { driveId, threadId: ThreadId.make(threadId) };
};
