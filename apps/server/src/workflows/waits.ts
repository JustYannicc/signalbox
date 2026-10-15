import {
  ThreadId,
  type AutomationDefaults,
  type AutomationError,
  type WorkflowDuration,
} from "@t3tools/contracts";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";
import * as Effect from "effect/Effect";

import type { Attachments } from "./attachments.ts";
import type { CallbackLink } from "./callbacks.ts";
import { waitForEventProblem } from "./compiler/eventTriggers.ts";
import type { AuthorizeAutomation } from "./catalog.ts";
import { fail } from "./errors.ts";
import type { RunLinkStore } from "./runLinkStore.ts";
import { explained } from "./runLog.ts";
import type { WorkflowStore } from "./WorkflowStore.ts";

/**
 * An agent waiting on something: a run of a built-in automation attached to
 * its thread, so the thread stays in Working, the wait shows in the thread,
 * and settling, archiving or stopping the thread ends it. `wait_for` runs
 * "Wait for"; `watch_pull_request` runs "Watch pull request". Both are
 * ordinary automations a project can customize; this only starts, lists and
 * stops them for a thread.
 */

export interface WaitRequest {
  readonly threadId: string;
  /** What's being waited on, read after "Waiting for". */
  readonly until: string;
  readonly message?: string | undefined;
  readonly on?: string | ReadonlyArray<string> | undefined;
  readonly where?: Readonly<Record<string, unknown>> | undefined;
  readonly callback?: boolean | undefined;
  readonly at?: string | undefined;
  readonly timeout?: WorkflowDuration | undefined;
}

export interface WaitStarted {
  readonly waitId: string;
  /** For `callback: true`: where the third party calls. */
  readonly callback: CallbackLink | null;
}

export interface Wait {
  readonly waitId: string;
  readonly automation: string;
  /** What the thread shows for it. */
  readonly label: string;
  readonly startedAt: string;
}

export interface PullRequestWatchRequest {
  readonly threadId: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly host: string;
  readonly watching: boolean;
}

/** How a wait is started, so the caller's access and defaults apply. */
export interface WaitAccess<E> {
  readonly authorize?: AuthorizeAutomation<E>;
  readonly builtInDefaults?: AutomationDefaults;
}

export const makeWaits = (deps: {
  readonly store: WorkflowStore;
  readonly links: RunLinkStore;
  readonly attachments: Attachments;
  readonly newId: (prefix: string) => Effect.Effect<string, AutomationError>;
  readonly start: <E>(
    input: {
      readonly automationId: string;
      readonly input: unknown;
      readonly attach: {
        readonly threadId: ThreadId;
        readonly key: string;
        readonly label: string;
      };
    } & WaitAccess<E>,
  ) => Effect.Effect<{ readonly id: string }, AutomationError | E>;
  readonly callback: (
    runId: string,
    hookId: string,
  ) => Effect.Effect<CallbackLink, AutomationError>;
  readonly cancel: (runId: string) => Effect.Effect<boolean, AutomationError>;
}) => {
  const start = <E = never>(request: WaitRequest, access: WaitAccess<E>) =>
    Effect.gen(function* () {
      const kinds = [
        request.on !== undefined,
        request.callback === true,
        request.at !== undefined,
      ].filter(Boolean).length;
      if (kinds !== 1)
        return yield* explained("Say what to wait for with exactly one of on, callback or at.", {
          fix: 'e.g. { until: "checks on #12 to fail", on: "pr.checks.failed", where: { number: 12 } }, { until: "the payment", callback: true }, or { until: "tomorrow morning", at: "2026-10-16T08:00:00Z" }.',
        });
      // Checked here, so a mistake comes back to the agent instead of failing after its turn ended.
      const problem = request.on === undefined ? null : waitForEventProblem(request.on);
      if (problem) return yield* explained(problem.message, { fix: problem.hint });
      if (request.at !== undefined && Number.isNaN(Date.parse(request.at)))
        return yield* explained(`"${request.at}" isn't a time.`, {
          fix: 'Give an ISO time, e.g. "2026-10-16T08:00:00Z".',
        });
      const id = yield* deps.newId("wait");
      // Chosen before the run starts, so the run waits on it from its first step.
      const hookId = request.callback ? yield* deps.newId("callback") : undefined;
      const run = yield* deps.start({
        automationId: "builtin:wait-for",
        input: {
          threadId: request.threadId,
          until: request.until,
          message: request.message,
          on: request.on,
          where: request.where,
          callback: hookId,
          at: request.at,
          timeout: request.timeout,
        },
        attach: {
          threadId: ThreadId.make(request.threadId),
          key: id,
          label: `Waiting for ${request.until}`,
        },
        ...access,
      });
      // Without its link the run would wait on nothing, forever.
      const callback = hookId
        ? yield* deps
            .callback(run.id, hookId)
            .pipe(Effect.onError(() => deps.cancel(run.id).pipe(Effect.ignore)))
        : null;
      return { waitId: run.id, callback } satisfies WaitStarted;
    });

  /** The thread's waits: every run attached to it. */
  const list = (threadId: string) =>
    Effect.gen(function* () {
      const waits: Wait[] = [];
      for (const link of yield* deps.links.runningAttachedTo(threadId)) {
        const run = yield* deps.store.getRun(link.run_id);
        const automation = run ? yield* deps.store.getAutomation(run.automation_id) : undefined;
        if (!run || !automation) continue;
        waits.push({
          waitId: run.run_id,
          automation: automation.name,
          label: deps.attachments.shownOn(threadId, run.run_id) ?? link.label ?? automation.name,
          startedAt: run.started_at,
        });
      }
      return waits;
    });

  /** Ends one of the thread's waits. */
  const stop = (threadId: string, waitId: string) =>
    Effect.gen(function* () {
      const link = yield* deps.links.getLink(waitId);
      if (link?.thread_id !== threadId)
        return yield* fail("That isn't one of this thread's waits; list_waits shows them.");
      return yield* deps.cancel(waitId);
    });

  /** `watch_pull_request`: runs "Watch pull request" attached to the thread, or stops it. */
  const watchPullRequest = <E = never>(request: PullRequestWatchRequest, access: WaitAccess<E>) =>
    Effect.gen(function* () {
      const key = `pull-request:${threadPullRequestKeyOf(request)}`;
      const running = yield* deps.links.runningAttached(request.threadId, key);
      if (!request.watching) {
        if (running) yield* deps.cancel(running);
        return { watching: false, wasWatching: running !== undefined };
      }
      yield* deps.start({
        automationId: "builtin:watch-pull-request",
        input: {
          threadId: request.threadId,
          number: request.number,
          repository: request.repository,
          url: request.url,
        },
        attach: {
          threadId: ThreadId.make(request.threadId),
          key,
          label: `Watching pull request #${request.number}`,
        },
        ...access,
      });
      return { watching: true, wasWatching: running !== undefined };
    });

  return { start, list, stop, watchPullRequest };
};

export type Waits = ReturnType<typeof makeWaits>;
