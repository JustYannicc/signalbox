import { type OrchestrationProjectShell, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  type SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";

import * as Environment from "../environment.ts";
import type { ThreadWorktree } from "../thread/threadDecider.ts";
import type { RemoteProject } from "./UserContexts.ts";

/**
 * Each context's project, which a new thread in it acts as. Personal is
 * Scratch, the "No project" every new thread starts in; a work organization is
 * a project named after it. Drives replace these projects (#140); a thread's
 * context stays fixed either way.
 *
 * A context also holds the remote repositories imported into it (#135). Each
 * thread there works on its own branch, which clients address by the thread's
 * working tree under the project's root.
 */

const ORGANIZATION_PROJECT_PREFIX = "context:";

export const projectIdForContext = (contextId: SignalboxContextId): ProjectId =>
  contextId === PERSONAL_CONTEXT_ID
    ? Environment.SCRATCH_PROJECT_ID
    : ProjectId.make(`${ORGANIZATION_PROJECT_PREFIX}${contextId}`);

/** The context a thread in `projectId` acts as, or null when it's none of `contexts`. */
export const contextOfProject = (
  contexts: ReadonlyArray<SignalboxContext>,
  projectId: ProjectId,
): SignalboxContextId | null =>
  contexts.find((context) => context.projectIds.includes(projectId))?.id ?? null;

/** The sidebar's projects: each context's own, then its imported ones, in the contexts' order. */
export const contextProjects = (
  contexts: ReadonlyArray<SignalboxContext>,
  remoteProjects: ReadonlyArray<RemoteProject> = [],
): ReadonlyArray<OrchestrationProjectShell> =>
  contexts.flatMap((context) => [
    context.kind === "personal"
      ? Environment.scratchProject
      : {
          ...Environment.scratchProject,
          id: projectIdForContext(context.id),
          title: context.name,
          workspaceRoot: `/contexts/${context.id}`,
        },
    ...remoteProjects
      .filter((project) => project.contextId === context.id)
      .map((project): OrchestrationProjectShell => ({
        ...Environment.scratchProject,
        id: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
      })),
  ]);

/** Where an imported GitHub repository lives for clients. */
export const githubWorkspaceRoot = (repository: string) => `/github/${repository}`;

const THREADS_SEGMENT = "/threads/";

/**
 * A thread's own branch on the remote, and its working tree's path. The branch
 * name only has to be stable and unlikely to collide within one repository.
 */
export const remoteThreadWorktree = (
  project: Pick<RemoteProject, "workspaceRoot">,
  threadId: ThreadId,
): ThreadWorktree => ({
  branch: `signalbox/${threadId
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(-8)
    .toLowerCase()}`,
  path: `${project.workspaceRoot}${THREADS_SEGMENT}${threadId}`,
});

/** What a client's `cwd` names among remote projects: a project's root, or one thread's working tree. */
export const remoteProjectAt = (
  remoteProjects: ReadonlyArray<RemoteProject>,
  cwd: string,
): { readonly project: RemoteProject; readonly threadId: ThreadId | null } | null => {
  for (const project of remoteProjects) {
    if (cwd === project.workspaceRoot) return { project, threadId: null };
    const prefix = `${project.workspaceRoot}${THREADS_SEGMENT}`;
    if (cwd.startsWith(prefix) && cwd.length > prefix.length) {
      return { project, threadId: ThreadId.make(cwd.slice(prefix.length)) };
    }
  }
  return null;
};
