import type { ProjectId } from "@t3tools/contracts";
import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { contextOfProject } from "./contextProjects.ts";
import * as UserContexts from "./UserContexts.ts";

/** What `CloudThreadService` needs to know about contexts: which one a new thread acts as. */
export class ThreadContexts extends Context.Service<
  ThreadContexts,
  {
    /** The acting user's context whose project this is, or null when it's none of theirs. */
    readonly contextOfProject: (projectId: ProjectId) => Effect.Effect<SignalboxContextId | null>;
  }
>()("@signalbox/cloud/user/threadContexts") {}

/** In a user's object: their current contexts. */
export const layer = Layer.effect(
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
export const layerWorker = Layer.succeed(
  ThreadContexts,
  ThreadContexts.of({
    contextOfProject: () => Effect.die("Threads are created in their user's object."),
  }),
);
