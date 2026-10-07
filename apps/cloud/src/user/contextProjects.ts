import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  type SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Environment from "../environment.ts";
import * as UserContexts from "./UserContexts.ts";

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
  contexts.find((context) => projectIdForContext(context.id) === projectId)?.id ?? null;

/** The sidebar's projects: one per context, in the contexts' order. */
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

/** What `CloudThreadService` needs to know about contexts: which one a new thread acts as. */
export class ThreadContexts extends Context.Service<
  ThreadContexts,
  {
    /** The acting user's context whose project this is, or null when it's none of theirs. */
    readonly contextOfProject: (projectId: ProjectId) => Effect.Effect<SignalboxContextId | null>;
  }
>()("@signalbox/cloud/user/contextProjects/ThreadContexts") {}

/** In a user's object: their current contexts. */
export const layerThreadContexts = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const contexts = yield* UserContexts.UserContexts;
    return ThreadContexts.of({
      contextOfProject: (projectId) =>
        contexts.contexts.pipe(
          Effect.map((current) => contextOfProject(current, projectId)),
          // A storage failure is a bug, not a rejected command.
          Effect.orDie,
        ),
    });
  }),
);

/** In the Worker, which only reads threads. Threads are created in their user's object. */
export const layerNoThreadContexts = Layer.succeed(
  ThreadContexts,
  ThreadContexts.of({
    contextOfProject: () => Effect.die("Threads are created in their user's object."),
  }),
);
