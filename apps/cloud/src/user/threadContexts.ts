import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ThreadWorktree } from "../thread/threadDecider.ts";
import { contextOfProject, remoteThreadWorktree } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";

/** Where a new thread goes: the context it acts as, and its own branch when its project has one per thread. */
export interface ThreadPlacement {
  readonly contextId: SignalboxContextId | null;
  readonly worktree: ThreadWorktree | null;
}

/** What `CloudThreadService` needs to know about contexts: where a new thread goes. */
export class ThreadContexts extends Context.Service<
  ThreadContexts,
  {
    /** The acting user's context whose project this is (null when it's none of theirs), and the thread's worktree. */
    readonly placementOf: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadPlacement>;
  }
>()("@signalbox/cloud/user/threadContexts") {}

/** In a user's object: their current contexts. */
export const layer = Layer.effect(
  ThreadContexts,
  Effect.gen(function* () {
    const contexts = yield* UserContexts.UserContexts;
    return ThreadContexts.of({
      placementOf: (projectId, threadId) =>
        Effect.gen(function* () {
          const contextId = contextOfProject(yield* contexts.contexts, projectId);
          const remote = (yield* contexts.remoteProjects).find(
            (project) => project.projectId === projectId,
          );
          return {
            contextId,
            worktree:
              contextId === null || remote === undefined
                ? null
                : remoteThreadWorktree(remote, threadId),
          };
        }).pipe(
          // A storage failure is a bug, not a rejected command.
          Effect.orDie,
        ),
    });
  }),
);

/** In the Worker, which only reads threads. Threads are created in their user's object. */
export const layerWorker = Layer.succeed(
  ThreadContexts,
  ThreadContexts.of({
    placementOf: () => Effect.die("Threads are created in their user's object."),
  }),
);
