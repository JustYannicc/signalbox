import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  type SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";

import * as Environment from "../environment.ts";

/**
 * Each context's project, which a new thread in it acts as. Personal is
 * Scratch, the "No project" every new thread starts in; a work organization is
 * a project named after it. Drives replace these projects (#140); a thread's
 * context stays fixed either way.
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

/** The sidebar's projects: each context's, in the contexts' order. */
export const contextProjects = (
  contexts: ReadonlyArray<SignalboxContext>,
): ReadonlyArray<OrchestrationProjectShell> =>
  contexts.map((context) =>
    context.kind === "personal"
      ? Environment.scratchProject
      : {
          ...Environment.scratchProject,
          id: projectIdForContext(context.id),
          title: context.name,
          workspaceRoot: `/contexts/${context.id}`,
        },
  );
