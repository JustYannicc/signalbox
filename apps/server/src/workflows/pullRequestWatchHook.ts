import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { loadCaller } from "../mcp/threadAccess.ts";
import { PullRequestWatchFailedError } from "../mcp/toolkits/pullRequests/tools.ts";
import { withinLimits } from "./callerAccess.ts";
import type { Waits } from "./waits.ts";

/**
 * `watch_pull_request` and `unwatch_pull_request` start and stop the built-in
 * "Watch pull request" automation instead of upstream's watch, through one
 * hook line in upstream's handler. Upstream's reactor stays in place: a watch
 * it already holds (started from the app, or before this shipped) stays with
 * it, so watching it again or unwatching it goes to upstream. The engine
 * registers itself at startup, like the thread monitor source; without it (a
 * server without automations) upstream's watch carries on.
 */

interface Target {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

let watch: Waits["watchPullRequest"] | undefined;

/** Set by the engine while it runs; it clears it when it stops. */
export const setPullRequestWatchHandler = (next: Waits["watchPullRequest"] | undefined) => {
  watch = next;
};

/** The watch result for upstream's tool, or undefined to let upstream handle it. */
export const watchWithAutomation = (
  thread: OrchestrationV2ThreadShell,
  target: Target,
  watching: boolean,
  upstreamWatching: boolean,
) => {
  const start = watch;
  if (!start || upstreamWatching) return Effect.succeed(undefined);
  return Effect.gen(function* () {
    // The run acts for whoever called, never with more access than they have.
    const { caller, limits } = yield* loadCaller();
    const result = yield* start(
      { threadId: thread.id, ...target, watching },
      {
        authorize: withinLimits(limits),
        builtInDefaults: {
          modelSelection: caller?.modelSelection ?? thread.modelSelection,
          runtimeMode: limits.runtimeMode,
          interactionMode: limits.interactionMode,
        },
      },
    );
    return { ...target, ...result };
  }).pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })));
};
