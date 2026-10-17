import {
  ThreadId,
  automationEventMatches,
  type AutomationDefaults,
  type AutomationError,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type WorkflowDuration,
  type WorkflowEventTrigger,
  type WorkflowSourceWatch,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import {
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { Attachments } from "./attachments.ts";
import type { CallbackLink } from "./host.ts";
import { sourceWatchProblem, waitForEventProblem } from "./compiler/eventTriggers.ts";
import type { AuthorizeAutomation } from "./catalog.ts";
import type { Envelope } from "./events/eventTriggers.ts";
import { cap, iso } from "./events/candidate.ts";
import { runCandidates } from "./events/turns.ts";
import { whereMatches } from "./events/subscriptions.ts";
import { automationError, fail } from "./errors.ts";
import type { AutomationThreads } from "./host.ts";
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
  /** A connected source to watch; `on` may narrow it to source.item.added and so on. */
  readonly watch?: WorkflowSourceWatch | undefined;
  /** With `watch`: what a change has to show, in words. */
  readonly condition?: string | undefined;
  readonly callback?: boolean | undefined;
  readonly at?: string | undefined;
  readonly timeout?: WorkflowDuration | undefined;
}

const eventPatterns = (on: WaitRequest["on"]): ReadonlyArray<string> =>
  typeof on === "string" ? [on] : (on ?? []);

export interface WaitStarted {
  readonly waitId: string;
  /** True when the requested event already matched current state at registration. */
  readonly alreadySatisfied: boolean;
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

/** Cloud reads run state and the assistant result from one committed inbox sequence. */
const turnFinishedFields = (
  run: OrchestrationV2Run,
  shell: OrchestrationV2ThreadShell,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  sequence: number,
) => {
  const records = { messages, turnItems: [] };
  const lastMessage = subagentResultForRun(records, { ...run, status: "completed" }).text;
  const error =
    run.status === "failed"
      ? cap(subagentResultForRun(records, run).text) || "The turn failed."
      : null;
  return {
    provider: run.providerInstanceId,
    model: run.modelSelection.model,
    status: run.status,
    sequence,
    lastMessage: cap(lastMessage),
    error,
    errorClass: shell.lastErrorClass ?? null,
    usageLimitResetAt: shell.usageLimitResetAt ?? null,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.completedAt),
  };
};

export const makeWaits = (deps: {
  readonly store: WorkflowStore;
  readonly threads: AutomationThreads["Service"];
  readonly links: RunLinkStore;
  readonly attachments: Attachments;
  readonly newId: (prefix: string) => Effect.Effect<string, AutomationError>;
  readonly start: <E>(
    input: {
      readonly automationId: string;
      readonly input: unknown;
      readonly eventPatterns?: ReadonlyArray<string> | undefined;
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
  /** Delivers a historical event to this wait only, using the normal run inbox. */
  readonly deliverCurrent: (runId: string, event: Envelope) => Effect.Effect<void, AutomationError>;
  readonly cancel: (runId: string) => Effect.Effect<boolean, AutomationError>;
}) => {
  const start = <E = never>(request: WaitRequest, access: WaitAccess<E>) =>
    Effect.gen(function* () {
      const kinds = [
        request.on !== undefined || request.watch !== undefined,
        request.callback === true,
        request.at !== undefined,
      ].filter(Boolean).length;
      if (kinds !== 1)
        return yield* explained(
          "Say what to wait for with exactly one of on, watch, callback or at.",
          {
            fix: 'e.g. { until: "checks on #12 to fail", on: "pr.checks.failed", where: { number: 12 } }, { until: "the invoice to be paid", watch: { operation: "stripe.invoices.list", key: "id" }, condition: "its status is paid" }, { until: "the payment", callback: true }, or { until: "tomorrow morning", at: "2026-10-16T08:00:00Z" }.',
          },
        );
      if (request.condition !== undefined && request.watch === undefined)
        return yield* explained(
          "`condition` judges changes to a watched source; pass `watch` too.",
          {
            fix: 'e.g. { watch: { operation: "stripe.invoices.list", key: "id" }, condition: "its status is paid" }',
          },
        );
      // Checked here, so a mistake comes back to the agent instead of failing after its turn ended.
      const problem =
        (request.on === undefined
          ? null
          : waitForEventProblem(request.on, request.watch !== undefined)) ??
        (request.watch === undefined ? null : sourceWatchProblem(request.watch, request.on));
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
          watch: request.watch,
          condition: request.condition,
          callback: hookId,
          at: request.at,
          timeout: request.timeout,
        },
        eventPatterns: eventPatterns(request.on),
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
      const alreadySatisfied = yield* deliverCurrentTurn(run.id, request).pipe(
        Effect.onError(() => deps.cancel(run.id).pipe(Effect.ignore)),
      );
      return { waitId: run.id, callback, alreadySatisfied } satisfies WaitStarted;
    });

  /** A wait on one named thread also sees that thread's latest completed turn. */
  const deliverCurrentTurn = (waitRunId: string, request: WaitRequest) =>
    Effect.gen(function* () {
      if (
        request.watch !== undefined ||
        !eventPatterns(request.on).some((pattern) =>
          automationEventMatches(pattern, "turn.finished"),
        )
      )
        return false;

      // A historical read needs one explicit target; scanning a folder would expose unrelated
      // private threads and turn a broad event subscription into a historical query.
      const target = request.where?.threadId;
      if (typeof target !== "string") return false;

      const caller = yield* deps.threads.getThreadShell(ThreadId.make(request.threadId));
      if (!caller) return false;

      const threadId = ThreadId.make(target);
      const shell = yield* deps.threads.getThreadShell(threadId);
      if (!shell || shell.projectId !== caller.projectId) return false;

      const inbox = deps.threads.readInbox ? yield* deps.threads.readInbox(threadId) : undefined;
      const runs = inbox?.runs ?? (yield* deps.threads.getThreadRecords(threadId, ["runs"])).runs;
      const latest = runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (!latest?.completedAt) return false;

      const candidate = runCandidates(latest).find((event) => event.name === "turn.finished");
      if (!candidate) return false;
      const fields =
        inbox === undefined
          ? yield* candidate.build({ shell: Effect.succeed(shell), threads: deps.threads })
          : turnFinishedFields(latest, shell, inbox.messages, inbox.sequence);
      if (fields === null) return false;

      const event: Envelope = {
        event: candidate.name,
        id: candidate.id,
        at: DateTime.formatIso(latest.completedAt),
        projectId: shell.projectId,
        threadId,
        runId: latest.id,
        threadTitle: shell.title,
        ...fields,
      };
      if (!whereMatches(request.where as WorkflowEventTrigger["where"], event)) return false;
      yield* deps.deliverCurrent(waitRunId, event);
      return true;
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

  /**
   * `merge_pull_request`: runs the folder's "Merge gate" attached to the
   * thread; it decides. The pull request has to be the thread's own and open,
   * and asking again while a request waits changes nothing.
   */
  const requestMerge = <E = never>(
    request: {
      readonly threadId: string;
      readonly url: string;
      readonly note?: string | undefined;
      readonly askBecause?: string | undefined;
    },
    access: WaitAccess<E>,
  ) =>
    Effect.gen(function* () {
      const target = parseChangeRequestUrl(request.url);
      if (target === null)
        return yield* explained(`"${request.url}" isn't a pull request URL.`, {
          fix: "Pass the pull request's URL, e.g. https://github.com/owner/repo/pull/12.",
        });
      const shell = yield* deps.threads
        .getThreadShell(ThreadId.make(request.threadId))
        .pipe(Effect.mapError((cause) => automationError("Couldn't read the thread.", { cause })));
      const linked = (shell ? visibleThreadPullRequests(threadPullRequestsOf(shell)) : []).find(
        (link) => threadPullRequestKeysEqual(link, target),
      );
      if (!linked)
        return yield* explained(`${request.url} isn't linked to this thread.`, {
          fix: "Link it with link_pull_request, then ask again.",
        });
      const state = linked.snapshot?.state;
      if (state === "merged" || state === "closed")
        return yield* explained(`${request.url} is already ${state}.`, {
          fix: "There's nothing to merge; tell the user where things stand.",
        });
      const key = `merge:${threadPullRequestKeyOf(linked)}`;
      const waiting = yield* deps.links.runningAttached(request.threadId, key);
      if (waiting) return { waitId: waiting, alreadyRequested: true };
      const run = yield* deps.start({
        automationId: "builtin:merge-gate",
        input: {
          threadId: request.threadId,
          url: request.url,
          note: request.note,
          askBecause: request.askBecause,
        },
        attach: {
          threadId: ThreadId.make(request.threadId),
          key,
          label: `Merging #${linked.number}`,
        },
        ...access,
      });
      return { waitId: run.id, alreadyRequested: false };
    });

  return { start, list, stop, watchPullRequest, requestMerge };
};

export type Waits = ReturnType<typeof makeWaits>;
