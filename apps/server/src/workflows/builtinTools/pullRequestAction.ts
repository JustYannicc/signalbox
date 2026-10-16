import {
  OrchestratorMcpFailure,
  PullRequestAction,
  PullRequestCheckStatus,
  PullRequestMergeability,
  PullRequestMergeMethod,
  PullRequestState,
  ThreadId,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { PullRequestSyncReactor } from "../../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { errorMessage } from "@signalbox/automations/errors";

/**
 * `signalbox.pull_request_action`: upstream's pull request actions (merge,
 * delete the branch, bring the base in, …) as a step automations take. It
 * lives here, not with the agent tools: the automation tool runner routes it
 * and the MCP server never registers it, so agents ask to merge with
 * `merge_pull_request` and the folder's merge gate decides. That's the path
 * agents are told to use, not a security boundary: a full-access agent with a
 * shell can still run `gh pr merge`.
 *
 * The pull request has to be linked to the thread. The result is its state
 * afterwards, since a host can take a merge into a queue instead of merging.
 */

// draft and revert make new work rather than finish it, and approve-workflows runs others' code.
const Action = Schema.Literals(
  PullRequestAction.literals.filter(
    (action) => action !== "draft" && action !== "revert" && action !== "approve-workflows",
  ),
);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  PullRequestService.PullRequestService,
];
const Target = {
  threadId: ThreadId.annotate({ description: "The thread the pull request is linked to." }),
  url: Schema.String.annotate({ description: "The pull request's URL." }),
};

const PullRequestReadTool = Tool.make("pull_request_read", {
  description:
    "Read a pull request linked to a thread, fresh from the host: where it lives, its title, state and head commit, and the merge gate's evidence at that commit. Parts the host can't answer here are null: review threads, the review decision and the changed files are read only in the cloud so far.",
  parameters: Schema.Struct(Target),
  success: Schema.Struct({
    repository: Schema.String,
    number: Schema.Int,
    title: Schema.String,
    state: PullRequestState,
    headSha: Schema.NullOr(Schema.String),
    isDraft: Schema.Boolean,
    mergeability: PullRequestMergeability,
    reviewDecision: Schema.Null,
    checks: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: PullRequestCheckStatus,
          url: Schema.NullOr(Schema.String),
          required: Schema.NullOr(Schema.Boolean),
        }),
      ),
    ),
    openThreads: Schema.Null,
    files: Schema.Null,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read pull request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const PullRequestActionTool = Tool.make("pull_request_action", {
  description:
    "Run one action on a pull request linked to a thread: merge it, delete its branch after it merged, bring its base in, hand the merge to the host (enable-auto-merge), mark it ready, close or reopen it. Returns the pull request's state afterwards; a merge the host queued is still open. With expectedHeadSha, nothing happens if new commits landed since (moved: true).",
  parameters: Schema.Struct({
    ...Target,
    action: Action,
    mergeMethod: Schema.optional(PullRequestMergeMethod).annotate({
      description: "For merge: merge, squash or rebase. Default: the host's.",
    }),
    expectedHeadSha: Schema.optional(Schema.String).annotate({
      description: "The head commit someone approved; act only while it's still the head.",
    }),
  }),
  success: Schema.Struct({ state: PullRequestState, moved: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Pull request action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const PullRequestActionToolkit = Toolkit.make(PullRequestReadTool, PullRequestActionTool);

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
/** The host or the server failed, not the request. */
const hostFailure = (what: string, cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `${what}: ${errorMessage(cause)}`,
  });

/** The pull request at `url`, as linked to the thread (unlinked or dismissed ones are refused). */
const linkedPullRequest = (threadId: ThreadId, url: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => hostFailure("Couldn't read the thread", cause)));
    if (thread === null || thread.deletedAt !== null)
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: `There's no thread ${threadId}.`,
      });
    const target = parseChangeRequestUrl(url);
    if (target === null) return yield* refused(`"${url}" isn't a pull request URL.`);
    const linked = visibleThreadPullRequests(threadPullRequestsOf(thread)).find((link) =>
      threadPullRequestKeysEqual(link, target),
    );
    if (!linked)
      return yield* refused(
        `${url} isn't linked to this thread. Link it with link_pull_request first.`,
      );
    const ref = {
      projectId: thread.projectId,
      host: linked.host,
      repository: linked.repository,
      number: linked.number,
    };
    const detail = pullRequests
      .detail({ ...ref, allowStale: false })
      .pipe(Effect.mapError((cause) => hostFailure("Couldn't read the pull request", cause)));
    return { linked, ref, detail, pullRequests };
  });

export const layer = McpToolAccess.toLayer(
  PullRequestActionToolkit,
  Effect.succeed({
    pull_request_read: McpToolAccess.reads(({ threadId, url }) =>
      Effect.gen(function* () {
        const { linked, detail } = yield* linkedPullRequest(threadId, url);
        const current = yield* detail;
        return {
          repository: linked.repository,
          number: linked.number,
          title: current.title,
          state: current.state,
          headSha: current.headSha ?? null,
          isDraft: current.isDraft,
          mergeability: current.mergeability,
          reviewDecision: null,
          // Checks without the commit they ran on can't be evidence about the head.
          checks:
            current.headSha === undefined
              ? null
              : current.checks.map((check) => ({
                  name: check.name,
                  status: check.status,
                  url: check.url,
                  required: check.required ?? null,
                })),
          openThreads: null,
          files: null,
        };
      }),
    ),
    pull_request_action: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      ({ threadId, url, action, mergeMethod, expectedHeadSha }) =>
        Effect.gen(function* () {
          const { linked, ref, detail, pullRequests } = yield* linkedPullRequest(threadId, url);
          // What someone approved is a commit; newer ones need their own approval. The host
          // merges whatever is the head when it gets the request, so this narrows the window
          // rather than closing it.
          if (expectedHeadSha !== undefined) {
            const before = yield* detail;
            if ((before.headSha ?? null) !== expectedHeadSha)
              return { state: before.state, moved: true };
          }
          const ran = yield* Effect.exit(
            pullRequests.runAction({
              ...ref,
              action,
              ...(mergeMethod === undefined ? {} : { mergeMethod }),
            }),
          );
          // A merge step that runs again after it worked finds the host already merged.
          if (ran._tag === "Failure") {
            const state =
              action === "merge"
                ? (yield* Effect.option(detail)).pipe(Option.map((after) => after.state))
                : Option.none();
            if (Option.getOrUndefined(state) !== "merged")
              return yield* hostFailure(
                `The host refused to ${action} it`,
                Cause.squash(ran.cause),
              );
          }
          // The thread's link catches up now instead of on the next sweep.
          const sync = yield* Effect.serviceOption(PullRequestSyncReactor);
          if (Option.isSome(sync)) yield* sync.value.requestSync(linked);
          return { state: (yield* detail).state, moved: false };
        }),
    ),
  }),
);
